from flask import Flask, request, jsonify, send_from_directory, redirect, session, Response
from flask_cors import CORS
from walmart_tool import search_product, build_cart_url
import anthropic, os, json, re, time, traceback, csv, io
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'), override=True)

# Allow OAuth over plain HTTP for localhost
os.environ.setdefault('OAUTHLIB_INSECURE_TRANSPORT', '1')

try:
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request as GRequest
    from google_auth_oauthlib.flow import Flow
    from googleapiclient.discovery import build as gcal_build
    _GCAL_AVAILABLE = True
except ImportError:
    _GCAL_AVAILABLE = False

app = Flask(__name__)
app.secret_key = os.getenv('FLASK_SECRET_KEY', 'grocery-agent-local-dev-secret')
CORS(app, origins="*")

GOOGLE_TOKEN_PATH = os.path.join(os.path.dirname(__file__), 'data', 'google_token.json')
GOOGLE_SCOPES     = ['https://www.googleapis.com/auth/calendar.readonly']

RECIPES_PATH = os.path.join(os.path.dirname(__file__), 'data', 'recipes.json')
PANTRY_PATH  = os.path.join(os.path.dirname(__file__), 'data', 'pantry.json')
PREFS_PATH   = os.path.join(os.path.dirname(__file__), 'data', 'prefs.json')

# Seeded from confirmed meal patterns in preferences.md — runs once on first launch
_SEED_RECIPES = [
    {"name": "Chicken Pot Pie",                "rating": 5, "tags": ["kid-friendly", "comfort-food"], "notes": "household favorite — 3× ordered, most repeated meal"},
    {"name": "Lasagna",                        "rating": 5, "tags": ["weekend", "comfort-food"],      "notes": "big batch Sunday cook, feeds family 2 nights"},
    {"name": "Pasta with Meat Sauce",          "rating": 4, "tags": ["comfort-food"],                 "notes": "Rao's Marinara + 80/20 ground beef"},
    {"name": "Fettuccine Alfredo with Chicken","rating": 4, "tags": ["comfort-food"],                 "notes": "heavy cream + parmesan + chicken thighs"},
    {"name": "Tacos",                          "rating": 4, "tags": ["quick", "kid-friendly"],        "notes": "taco seasoning + ROTEL + beans + avocado"},
    {"name": "Chili",                          "rating": 4, "tags": ["comfort-food"],                 "notes": "ROTEL + beans + crushed tomatoes — pairs with a taco week"},
    {"name": "Stuffed Crust Pizza",            "rating": 4, "tags": ["quick", "kid-friendly"],        "notes": "Great Value frozen 3-meat — reliable Friday night"},
    {"name": "Butter Chicken with Naan",       "rating": 4, "tags": ["quick"],                        "notes": "frozen butter chicken meal + Stonefire mini naan"},
    {"name": "Meatball Subs",                  "rating": 4, "tags": ["kid-friendly"],                 "notes": "frozen meatballs + crescent rolls"},
    {"name": "Lit'l Smokies Pigs in Blankets", "rating": 4, "tags": ["quick", "kid-friendly"],        "notes": "Hillshire Farm + Sweet Baby Ray's + crescent rolls"},
    {"name": "Hot Dogs",                       "rating": 4, "tags": ["quick", "kid-friendly"],        "notes": "Nathan's beef hot dogs + Martin's Long Rolls"},
    {"name": "Beef Birria Tacos",              "rating": 4, "tags": ["quick"],                        "notes": "Del Real Foods slow-cooked — just heat and serve"},
    {"name": "Rigatoni with Chicken Sausage",  "rating": 4, "tags": [],                               "notes": "Aidells Chicken Sausage with Mozzarella"},
    {"name": "Panera Soup Night",              "rating": 3, "tags": ["quick"],                        "notes": "Panera ready-to-heat soups — good for winter"},
]


@app.route('/')
def index():
    return send_from_directory('static', 'index.html')


@app.route('/ping')
def ping():
    return jsonify({"ok": True})


@app.route('/household-items', methods=['GET'])
def get_household_items():
    try:
        p = json.load(open(PREFS_PATH, encoding='utf-8'))
        if p.get('householdItems'):
            return jsonify({'items': p['householdItems']})
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return jsonify({'items': _parse_household_items()})


@app.route('/prefs', methods=['GET'])
def get_prefs():
    try:
        return jsonify(json.load(open(PREFS_PATH, encoding='utf-8')))
    except (FileNotFoundError, json.JSONDecodeError):
        return jsonify({})


@app.route('/prefs', methods=['POST'])
def save_prefs():
    os.makedirs(os.path.dirname(PREFS_PATH), exist_ok=True)
    json.dump(request.json, open(PREFS_PATH, 'w', encoding='utf-8'), indent=2)
    return jsonify({'ok': True})


@app.route('/preferences', methods=['GET'])
def get_preferences():
    prefs_path = os.path.join(os.path.dirname(__file__), 'preferences.md')
    try:
        content = open(prefs_path, encoding='utf-8').read()
        return jsonify({"content": content})
    except FileNotFoundError:
        return jsonify({"content": ""})


@app.route('/pantry', methods=['GET'])
def get_pantry():
    return jsonify(_load_pantry())


@app.route('/pantry', methods=['POST'])
def add_pantry_item():
    pantry = _load_pantry()
    body = request.json
    name = (body.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'name required'}), 400
    item = {
        'id':        str(int(time.time() * 1000)),
        'name':      name,
        'amount':    body.get('amount', ''),
        'unit':      body.get('unit', ''),
        'expiresOn': body.get('expiresOn', ''),
        'addedOn':   body.get('addedOn', ''),
    }
    pantry.append(item)
    _save_pantry(pantry)
    return jsonify(item), 201


@app.route('/pantry/<item_id>', methods=['PATCH'])
def update_pantry_item(item_id):
    pantry = _load_pantry()
    for item in pantry:
        if item['id'] == item_id:
            item.update({k: v for k, v in request.json.items() if k != 'id'})
            _save_pantry(pantry)
            return jsonify(item)
    return jsonify({'error': 'not found'}), 404


@app.route('/pantry/export', methods=['GET'])
def export_pantry():
    pantry = sorted(_load_pantry(), key=lambda x: x.get('name', '').lower())
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(['name', 'amount', 'unit', 'expires_on', 'added_on'])
    for item in pantry:
        w.writerow([item.get('name',''), item.get('amount',''), item.get('unit',''),
                    item.get('expiresOn',''), item.get('addedOn','')])
    return Response(out.getvalue(), mimetype='text/csv',
                    headers={'Content-Disposition': 'attachment; filename=pantry.csv'})


@app.route('/pantry/import', methods=['POST'])
def import_pantry():
    f = request.files.get('file')
    if not f:
        return jsonify({'error': 'no file uploaded'}), 400
    try:
        reader = csv.DictReader(io.StringIO(f.read().decode('utf-8-sig')))
    except Exception as e:
        return jsonify({'error': f'could not read file: {e}'}), 400
    pantry = _load_pantry()
    by_name = {p['name'].lower(): p for p in pantry}
    existing_ids = {p['id'] for p in pantry}
    id_counter = int(time.time() * 1000)
    imported = updated = 0
    for row in reader:
        name = (row.get('name') or '').strip()
        if not name:
            continue
        if name.lower() in by_name:
            item = by_name[name.lower()]
            if row.get('amount'):     item['amount']    = row['amount']
            if row.get('unit'):       item['unit']      = row['unit']
            if row.get('expires_on'): item['expiresOn'] = row['expires_on']
            if row.get('added_on'):   item['addedOn']   = row['added_on']
            updated += 1
        else:
            while str(id_counter) in existing_ids:
                id_counter += 1
            new_id = str(id_counter)
            existing_ids.add(new_id)
            id_counter += 1
            item = {
                'id': new_id, 'name': name,
                'amount': row.get('amount', ''), 'unit': row.get('unit', ''),
                'expiresOn': row.get('expires_on', ''), 'addedOn': row.get('added_on', ''),
            }
            pantry.append(item)
            by_name[name.lower()] = item
            imported += 1
    _save_pantry(pantry)
    return jsonify({'imported': imported, 'updated': updated, 'total': len(pantry)})


@app.route('/pantry/<item_id>', methods=['DELETE'])
def delete_pantry_item(item_id):
    _save_pantry([i for i in _load_pantry() if i['id'] != item_id])
    return jsonify({'ok': True})


@app.route('/recipes', methods=['GET'])
def get_recipes():
    return jsonify(_load_recipes())


@app.route('/recipes', methods=['POST'])
def add_recipe():
    recipes = _load_recipes()
    body = request.json
    name = (body.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'name required'}), 400
    for r in recipes:
        if r['name'].lower() == name.lower():
            r['timesPlanned'] = r.get('timesPlanned', 0) + body.get('timesPlanned', 1)
            r['lastPlanned'] = body.get('lastPlanned', r.get('lastPlanned', ''))
            if body.get('rating'):
                r['rating'] = body['rating']
            if body.get('notes'):
                r['notes'] = body['notes']
            _save_recipes(recipes)
            return jsonify(r), 200
    recipe = {
        'id': str(int(time.time() * 1000)),
        'name': name,
        'rating': body.get('rating', 0),
        'tags': body.get('tags', []),
        'notes': body.get('notes', ''),
        'timesPlanned': body.get('timesPlanned', 1),
        'lastPlanned': body.get('lastPlanned', ''),
    }
    recipes.append(recipe)
    _save_recipes(recipes)
    return jsonify(recipe), 201


@app.route('/recipes/<recipe_id>', methods=['PATCH'])
def update_recipe(recipe_id):
    recipes = _load_recipes()
    for r in recipes:
        if r['id'] == recipe_id:
            r.update({k: v for k, v in request.json.items() if k != 'id'})
            _save_recipes(recipes)
            return jsonify(r)
    return jsonify({'error': 'not found'}), 404


@app.route('/recipes/export', methods=['GET'])
def export_recipes():
    recipes = sorted(_load_recipes(), key=lambda x: x.get('name', '').lower())
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(['name', 'rating', 'tags', 'times_planned', 'last_planned', 'notes',
                'ingredients', 'steps'])
    for r in recipes:
        w.writerow([
            r.get('name', ''),
            r.get('rating', ''),
            ', '.join(r.get('tags', [])),
            r.get('timesPlanned', ''),
            r.get('lastPlanned', ''),
            r.get('notes', ''),
            ' | '.join(r.get('ingredients', [])),
            ' | '.join(r.get('steps', [])),
        ])
    return Response(out.getvalue(), mimetype='text/csv',
                    headers={'Content-Disposition': 'attachment; filename=recipes.csv'})


@app.route('/recipes/import', methods=['POST'])
def import_recipes():
    f = request.files.get('file')
    if not f:
        return jsonify({'error': 'no file uploaded'}), 400
    try:
        reader = csv.DictReader(io.StringIO(f.read().decode('utf-8-sig')))
    except Exception as e:
        return jsonify({'error': f'could not read file: {e}'}), 400
    recipes = _load_recipes()
    by_name = {r['name'].lower(): r for r in recipes}
    existing_ids = {r['id'] for r in recipes}
    id_counter = int(time.time() * 1000)
    imported = updated = 0
    for row in reader:
        name = (row.get('name') or '').strip()
        if not name:
            continue
        ingredients = [x.strip() for x in row.get('ingredients', '').split('|') if x.strip()]
        steps       = [x.strip() for x in row.get('steps', '').split('|') if x.strip()]
        tags        = [x.strip() for x in row.get('tags', '').split(',') if x.strip()]
        try:    rating = int(row.get('rating') or 0)
        except: rating = 0
        try:    times_planned = int(row.get('times_planned') or 0)
        except: times_planned = 0
        if name.lower() in by_name:
            r = by_name[name.lower()]
            if rating:                   r['rating']       = rating
            if tags:                     r['tags']         = tags
            if row.get('notes'):         r['notes']        = row['notes']
            if times_planned:            r['timesPlanned'] = times_planned
            if row.get('last_planned'):  r['lastPlanned']  = row['last_planned']
            if ingredients:              r['ingredients']  = ingredients
            if steps:                    r['steps']        = steps
            updated += 1
        else:
            while str(id_counter) in existing_ids:
                id_counter += 1
            new_id = str(id_counter)
            existing_ids.add(new_id)
            id_counter += 1
            recipe = {
                'id': new_id, 'name': name, 'rating': rating, 'tags': tags,
                'notes': row.get('notes', ''), 'timesPlanned': times_planned,
                'lastPlanned': row.get('last_planned', ''),
                'ingredients': ingredients, 'steps': steps,
            }
            recipes.append(recipe)
            by_name[name.lower()] = recipe
            imported += 1
    _save_recipes(recipes)
    return jsonify({'imported': imported, 'updated': updated, 'total': len(recipes)})


@app.route('/recipes/<recipe_id>', methods=['DELETE'])
def delete_recipe(recipe_id):
    _save_recipes([r for r in _load_recipes() if r['id'] != recipe_id])
    return jsonify({'ok': True})


@app.route('/generate-meal-plan', methods=['POST'])
def generate_meal_plan():
    prompt = (request.json or {}).get('prompt', '').strip()
    if not prompt:
        return jsonify({'error': 'prompt required'}), 400
    try:
        client = anthropic.Anthropic(api_key=os.getenv('ANTHROPIC_API_KEY'))
        msg = client.messages.create(
            model='claude-sonnet-4-6',
            max_tokens=600,
            messages=[{'role': 'user', 'content': prompt}]
        )
        return jsonify({'content': msg.content[0].text})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/generate-single-meal', methods=['POST'])
def generate_single_meal():
    data        = request.json or {}
    day         = data.get('day', 'a weekday')
    complexity  = data.get('complexity', 'normal')
    exclude     = data.get('exclude', [])
    complexity_desc = {
        'quick':  '30 minutes or less (frozen, heat-and-eat, simple assembly)',
        'normal': 'up to 1 hour (standard weeknight cooking)',
        'open':   'no time limit (slow cooker, elaborate recipes welcome)',
    }.get(complexity, 'up to 1 hour')
    exclude_str = ', '.join(exclude) if exclude else 'none'
    prompt = f"""Suggest ONE completely new dinner recipe for a family of 4 for {day}.
Time available: {complexity_desc}
Do NOT suggest any of these: {exclude_str}
Family: kid-friendly comfort food, chicken, pasta, tacos, American/Italian/Mexican cuisine, practical weeknight meals.
Return ONLY the recipe name — no explanation, no punctuation, just the name."""
    try:
        client = anthropic.Anthropic(api_key=os.getenv('ANTHROPIC_API_KEY'))
        msg = client.messages.create(
            model='claude-sonnet-4-6', max_tokens=30,
            messages=[{'role': 'user', 'content': prompt}]
        )
        name = msg.content[0].text.strip().strip('"\'.')
        return jsonify({'meal': name})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/generate-recipe', methods=['POST'])
def generate_recipe():
    meal_name = (request.json or {}).get('meal', '').strip()
    if not meal_name:
        return jsonify({'error': 'meal name required'}), 400
    try:
        h = {}
        try:
            p = json.load(open(PREFS_PATH, encoding='utf-8'))
            h = p.get('household', {})
        except (FileNotFoundError, json.JSONDecodeError):
            pass
        servings = int(h.get('adults', 2)) + int(h.get('kids', 0))
        client = anthropic.Anthropic(api_key=os.getenv('ANTHROPIC_API_KEY'))
        msg = client.messages.create(
            model='claude-sonnet-4-6',
            max_tokens=800,
            messages=[{
                'role': 'user',
                'content': f'''Generate a complete recipe for "{meal_name}" for {servings} people.
Return ONLY a JSON object, no markdown, no explanation:
{{"ingredients": ["amount + ingredient name", ...], "steps": ["Step description", ...]}}
Keep it practical and family-friendly. 6-10 ingredients, 5-8 steps. Each step should be one clear sentence.'''
            }]
        )
        text = msg.content[0].text.strip().replace('```json', '').replace('```', '').strip()
        return jsonify(json.loads(text))
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/build-cart', methods=['POST'])
def build_cart():
    try:
        data      = request.json
        meals     = data.get('meals', [])
        household = data.get('household', [])
        zip_code  = data.get('zip', os.getenv('DELIVERY_ZIP', '59047'))

        print(f"\n=== BUILD CART REQUEST ===")
        print(f"Meals: {meals}")

        # ── Phase 1: all Claude calls in parallel ─────────────────────────
        # One call per meal to generate search queries + one for staples.
        all_search_tasks = []

        claude_jobs = {}
        with ThreadPoolExecutor(max_workers=min(len(meals) + 1, 10)) as ex:
            for name in meals:
                claude_jobs[ex.submit(get_search_queries_for_meal, name)] = name
            staple_fut = ex.submit(get_staple_queries)
            claude_jobs[staple_fut] = '__staples__'

            for fut in as_completed(claude_jobs):
                label = claude_jobs[fut]
                try:
                    queries = fut.result()
                    source = label if label != '__staples__' else 'staples'
                    print(f"  [{source}]: {len(queries)} queries")
                    for q in queries:
                        all_search_tasks.append({**q, 'source': source})
                except Exception as e:
                    print(f"  ERROR getting queries for {label}: {e}")
                    traceback.print_exc()

        # Household items search directly — no Claude step needed
        for name in household:
            all_search_tasks.append({"search_query": name, "qty": 1, "source": "household"})

        print(f"\nTotal search tasks: {len(all_search_tasks)}")

        # ── Phase 2: all Walmart searches in parallel ─────────────────────
        search_results = []
        with ThreadPoolExecutor(max_workers=20) as ex:
            fut_to_task = {ex.submit(search_product, t['search_query']): t for t in all_search_tasks}
            for fut in as_completed(fut_to_task):
                task = fut_to_task[fut]
                try:
                    product = fut.result()
                    search_results.append((task, product))
                except Exception as e:
                    print(f"  - Search error for '{task['search_query']}': {e}")

        # ── Deduplicate and assemble cart ─────────────────────────────────
        cart_items     = []
        groups         = {}   # source -> [{name, price}]
        seen_ids       = set()
        total          = 0.0

        for task, product in search_results:
            if product:
                item_id = str(product['itemId'])
                if item_id not in seen_ids:
                    seen_ids.add(item_id)
                    price = float(product.get('salePrice', product.get('msrp', 0)))
                    cart_items.append({"itemId": item_id, "quantity": task.get('qty', 1)})
                    source = task.get('source', 'other')
                    groups.setdefault(source, []).append({
                        "name":  product.get("name", "Unknown"),
                        "price": f"${price:.2f}",
                    })
                    total += price
                    print(f"  + [{source}] {product['name']} ${price}")
            else:
                print(f"  - No result: {task['search_query']}")

        # Preserve meal order for the frontend (meals list + fixed categories)
        meal_order = list(meals) + ['staples', 'household']

        cart_url = build_cart_url(cart_items, staple_items=[])

        print(f"\nCart URL: {cart_url}")
        print(f"Total: ${total:.2f} across {sum(len(v) for v in groups.values())} items")

        flat_items = [item for src in meal_order for item in groups.get(src, [])]

        return jsonify({
            "groups":    groups,
            "mealOrder": meal_order,
            "items":     flat_items,
            "total":     f"${total:.2f}",
            "cartUrl":   cart_url
        })

    except Exception as e:
        print(f"\n=== CART BUILD ERROR ===")
        traceback.print_exc()
        return jsonify({"error": str(e), "trace": traceback.format_exc()}), 500


# ── Google Calendar ────────────────────────────────────────────────────────

@app.route('/calendar/status')
def calendar_status():
    if not _GCAL_AVAILABLE:
        return jsonify({'connected': False, 'setup': False, 'reason': 'google libraries not installed'})
    if not os.getenv('GOOGLE_CLIENT_ID'):
        return jsonify({'connected': False, 'setup': False, 'reason': 'GOOGLE_CLIENT_ID not set in .env'})
    creds = _load_google_creds()
    return jsonify({'connected': bool(creds and creds.valid), 'setup': True})


@app.route('/calendar/auth')
def calendar_auth():
    if not _GCAL_AVAILABLE or not os.getenv('GOOGLE_CLIENT_ID'):
        return 'Google Calendar not configured', 400
    flow = _make_google_flow()
    auth_url, state = flow.authorization_url(access_type='offline', prompt='consent')
    session['oauth_state'] = state
    if flow.code_verifier:
        session['code_verifier'] = flow.code_verifier
    return redirect(auth_url)


@app.route('/calendar/callback')
def calendar_callback():
    if not request.args.get('code'):
        return 'Authorization failed — no code returned', 400
    state   = session.pop('oauth_state', None)
    flow    = _make_google_flow(state=state)
    verifier = session.pop('code_verifier', None)
    kwargs  = {'authorization_response': request.url}
    if verifier:
        kwargs['code_verifier'] = verifier
    try:
        flow.fetch_token(**kwargs)
    except Exception as e:
        return f'Authorization failed: {e}. Try connecting again.', 400
    _save_google_creds(flow.credentials)
    return redirect('/')


@app.route('/calendar/week')
def calendar_week():
    if not _GCAL_AVAILABLE:
        return jsonify({'error': 'google libraries not installed'}), 503
    creds = _load_google_creds()
    if not creds:
        return jsonify({'error': 'not connected'}), 401
    if creds.expired and creds.refresh_token:
        try:
            creds.refresh(GRequest())
            _save_google_creds(creds)
        except Exception as e:
            return jsonify({'error': f'token refresh failed: {e}'}), 401

    service = gcal_build('calendar', 'v3', credentials=creds)

    # Load user timezone from prefs, default to America/Denver (Montana)
    try:
        with open(PREFS_PATH) as f:
            _prefs = json.load(f)
        tz_name = _prefs.get('timezone') or 'America/Denver'
    except Exception:
        tz_name = 'America/Denver'
    try:
        tz = ZoneInfo(tz_name)
    except Exception:
        tz = ZoneInfo('America/Denver')

    today  = datetime.now(tz)
    monday = today - timedelta(days=today.weekday())
    sunday = monday + timedelta(days=6)
    time_min = monday.replace(hour=0,  minute=0,  second=0,  microsecond=0).isoformat()
    time_max = sunday.replace(hour=23, minute=59, second=59, microsecond=0).isoformat()

    try:
        result = service.events().list(
            calendarId='primary',
            timeMin=time_min, timeMax=time_max,
            timeZone=tz_name,
            singleEvents=True, orderBy='startTime', maxResults=50
        ).execute()
    except Exception as e:
        return jsonify({'error': str(e)}), 500

    by_day = {d: [] for d in ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']}

    for event in result.get('items', []):
        start  = event.get('start', {})
        dt_str = start.get('dateTime') or start.get('date')
        if not dt_str:
            continue
        try:
            if start.get('dateTime'):
                dt = datetime.fromisoformat(dt_str).astimezone(tz)
                h, m = dt.hour, dt.minute
                am_pm = 'am' if h < 12 else 'pm'
                h12   = h % 12 or 12
                time_str = f"{h12}:{m:02d}{am_pm}" if m else f"{h12}{am_pm}"
            else:
                dt = datetime.fromisoformat(dt_str)
                time_str = 'all day'
            day_name = dt.strftime('%A')
            if day_name in by_day:
                by_day[day_name].append({'time': time_str, 'title': event.get('summary', 'Untitled')})
        except Exception:
            continue

    return jsonify(by_day)


@app.route('/calendar/disconnect', methods=['POST'])
def calendar_disconnect():
    if os.path.exists(GOOGLE_TOKEN_PATH):
        os.remove(GOOGLE_TOKEN_PATH)
    return jsonify({'ok': True})


def _make_google_flow(state=None):
    return Flow.from_client_config(
        {'web': {
            'client_id':     os.getenv('GOOGLE_CLIENT_ID'),
            'client_secret': os.getenv('GOOGLE_CLIENT_SECRET'),
            'auth_uri':      'https://accounts.google.com/o/oauth2/auth',
            'token_uri':     'https://oauth2.googleapis.com/token',
            'redirect_uris': ['http://localhost:5000/calendar/callback'],
        }},
        scopes=GOOGLE_SCOPES,
        redirect_uri='http://localhost:5000/calendar/callback',
        state=state
    )


def _load_google_creds():
    if not os.path.exists(GOOGLE_TOKEN_PATH):
        return None
    try:
        return Credentials.from_authorized_user_info(
            json.load(open(GOOGLE_TOKEN_PATH)), GOOGLE_SCOPES
        )
    except Exception:
        return None


def _save_google_creds(creds):
    os.makedirs(os.path.dirname(GOOGLE_TOKEN_PATH), exist_ok=True)
    with open(GOOGLE_TOKEN_PATH, 'w') as f:
        f.write(creds.to_json())


# ───────────────────────────────────────────────────────────────────────────

def _load_pantry() -> list:
    try:
        return json.load(open(PANTRY_PATH, encoding='utf-8'))
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _save_pantry(pantry: list) -> None:
    os.makedirs(os.path.dirname(PANTRY_PATH), exist_ok=True)
    json.dump(pantry, open(PANTRY_PATH, 'w', encoding='utf-8'), indent=2)


def _load_recipes() -> list:
    try:
        return json.load(open(RECIPES_PATH, encoding='utf-8'))
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _save_recipes(recipes: list) -> None:
    os.makedirs(os.path.dirname(RECIPES_PATH), exist_ok=True)
    json.dump(recipes, open(RECIPES_PATH, 'w', encoding='utf-8'), indent=2)


def _seed_recipes_if_empty() -> None:
    if _load_recipes():
        return
    seeded = [
        {**r, 'id': str(int(time.time() * 1000) + i), 'timesPlanned': 0, 'lastPlanned': ''}
        for i, r in enumerate(_SEED_RECIPES)
    ]
    _save_recipes(seeded)


def _parse_household_items() -> list[str]:
    """Extract bullet points from the Household / non-grocery section of preferences.md."""
    prefs_path = os.path.join(os.path.dirname(__file__), 'preferences.md')
    try:
        prefs = open(prefs_path, encoding='utf-8').read()
    except FileNotFoundError:
        return []
    items = []
    in_section = False
    for line in prefs.split('\n'):
        if line.startswith('## Household') and 'non-grocery' in line:
            in_section = True
            continue
        if in_section:
            if line.startswith('## '):
                break
            if line.startswith('- '):
                item = line[2:].strip()
                item = re.sub(r'\s*\*\(.*?\)\*', '', item).strip()
                if item:
                    items.append(item)
    return items


def get_search_queries_for_meal(meal_name: str) -> list[dict]:
    """Ask Claude to generate brand-aware Walmart search queries for a meal."""
    api_key = os.getenv('ANTHROPIC_API_KEY')
    if not api_key:
        raise ValueError("ANTHROPIC_API_KEY not set")

    client = anthropic.Anthropic(api_key=api_key)
    msg = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=600,
        messages=[{
            "role": "user",
            "content": f"""Generate Walmart grocery search queries for cooking {meal_name} for a family of 4.

Return ONLY a JSON array, no markdown, no explanation:
[{{"search_query": "descriptive product search string", "qty": 1}}, ...]

Rules:
- Use descriptive product terms, not brand names (e.g. "boneless skinless chicken thighs" not "Perdue chicken")
- Exception: Rao's Marinara and Prego pasta sauce — include brand name, those search well
- qty is number of packages to add to cart (almost always 1)
- Skip salt, pepper, olive oil — assume those are stocked
- 6-10 ingredients max"""
        }]
    )
    text = msg.content[0].text.strip().replace("```json", "").replace("```", "").strip()
    return json.loads(text)


def get_staple_queries() -> list[dict]:
    """Return weekly staples from prefs.json as Walmart search queries via Claude."""
    # Load staples from prefs.json, fall back to parsing preferences.md
    staples = []
    try:
        p = json.load(open(PREFS_PATH, encoding='utf-8'))
        staples = p.get('weeklyStaples', [])
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    if not staples:
        # Legacy fallback: parse preferences.md
        prefs_path = os.path.join(os.path.dirname(__file__), 'preferences.md')
        try:
            in_section = False
            for line in open(prefs_path, encoding='utf-8'):
                if '## Weekly staples' in line:
                    in_section = True
                    continue
                if in_section:
                    if line.startswith('## '):
                        break
                    if line.startswith('- '):
                        staples.append(line[2:].strip())
        except FileNotFoundError:
            return []

    staples_text = '\n'.join(f'- {s}' for s in staples)
    client = anthropic.Anthropic(api_key=os.getenv('ANTHROPIC_API_KEY'))
    msg = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=400,
        messages=[{
            "role": "user",
            "content": f"""Convert these weekly grocery staples to Walmart search queries:

{staples_text}

Return ONLY a JSON array, no markdown:
[{{"search_query": "descriptive product search string", "qty": 1}}, ...]

Use descriptive terms that work on Walmart search (e.g. "organic bananas bunch" not "Marketside Fresh Organic Bananas")."""
        }]
    )
    text = msg.content[0].text.strip().replace("```json", "").replace("```", "").strip()
    return json.loads(text)


if __name__ == '__main__':
    _seed_recipes_if_empty()
    print("=" * 50)
    print("Grocery agent server running at http://localhost:5000")
    print("Health check: http://localhost:5000/ping")
    print("Open index.html in Chrome to start planning.")
    print("=" * 50)
    app.run(port=5000, debug=False)
