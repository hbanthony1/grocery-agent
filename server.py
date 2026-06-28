from flask import Flask, request, jsonify, send_from_directory, redirect, session, Response
from flask_cors import CORS
from walmart_tool import search_product, build_cart_url
import anthropic, os, json, re, time, traceback, csv, io, socket, smtplib, shutil, requests
from functools import wraps
from werkzeug.security import generate_password_hash, check_password_hash
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'), override=True)

_APP_BASE_URL = os.getenv('APP_BASE_URL', 'http://localhost:5000').rstrip('/')
if 'localhost' in _APP_BASE_URL or '127.0.0.1' in _APP_BASE_URL:
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

GOOGLE_SCOPES = ['https://www.googleapis.com/auth/calendar.readonly']

_BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
_DATA_ROOT  = os.path.join(_BASE_DIR, 'data')
_USERS_PATH = os.path.join(_DATA_ROOT, 'users.json')
_STATIC_DIR = os.path.join(_BASE_DIR, 'static')

# Per-test path overrides — set via monkeypatch; None = use per-user routing
RECIPES_PATH       = None
PANTRY_PATH        = None
PREFS_PATH         = None
STAPLES_PATH       = None
SPEND_HISTORY_PATH = None
GOOGLE_TOKEN_PATH  = None
_DATA_DIR_OVERRIDE = None
_DEMO_MODE         = False


def _data_dir() -> str:
    if _DATA_DIR_OVERRIDE is not None:
        return _DATA_DIR_OVERRIDE
    username = session.get('username', '')
    return os.path.join(_DATA_ROOT, 'users', username) if username else os.path.join(_DATA_ROOT, 'default')


def _dpath(filename: str) -> str:
    _overrides = {
        'recipes.json':       lambda: RECIPES_PATH,
        'pantry.json':        lambda: PANTRY_PATH,
        'prefs.json':         lambda: PREFS_PATH,
        'staples.json':       lambda: STAPLES_PATH,
        'spend_history.json': lambda: SPEND_HISTORY_PATH,
        'google_token.json':  lambda: GOOGLE_TOKEN_PATH,
    }
    getter = _overrides.get(filename)
    if getter:
        override = getter()
        if override is not None:
            return override
    return os.path.join(_data_dir(), filename)


def _photos_dir() -> str:
    username = session.get('username', 'default')
    return os.path.join(_STATIC_DIR, 'photos', username)


MODEL = 'claude-sonnet-4-6'
_SERVER_START = format(int(time.time()), 'x')[-6:]  # hex timestamp — changes on every restart
_staple_query_cache: dict = {}

# Seeded from confirmed meal patterns in preferences.md — merged into new user accounts on first login
_SEED_RECIPES = [
    # ── Household favorites (original) ──────────────────────────────────────
    {"name": "Chicken Pot Pie",                "rating": 5, "tags": ["kid-friendly","comfort-food"],       "notes": "household favorite — 3× ordered, most repeated meal"},
    {"name": "Lasagna",                        "rating": 5, "tags": ["weekend","comfort-food"],            "notes": "big batch Sunday cook, feeds family 2 nights"},
    {"name": "Pot Roast",                      "rating": 5, "tags": ["weekend","comfort-food"],            "notes": "chuck roast + carrots + potatoes + onion in slow cooker — Sunday staple"},
    {"name": "Pasta with Meat Sauce",          "rating": 4, "tags": ["comfort-food"],                     "notes": "Rao's Marinara + 80/20 ground beef"},
    {"name": "Fettuccine Alfredo with Chicken","rating": 4, "tags": ["comfort-food"],                     "notes": "heavy cream + parmesan + chicken thighs"},
    {"name": "Tacos",                          "rating": 4, "tags": ["quick","kid-friendly"],             "notes": "taco seasoning + ROTEL + beans + avocado"},
    {"name": "Chili",                          "rating": 4, "tags": ["comfort-food"],                     "notes": "ROTEL + beans + crushed tomatoes — pairs with a taco week"},
    {"name": "Stuffed Crust Pizza",            "rating": 4, "tags": ["quick","kid-friendly"],             "notes": "Great Value frozen 3-meat — reliable Friday night"},
    {"name": "Butter Chicken with Naan",       "rating": 4, "tags": ["quick"],                            "notes": "frozen butter chicken meal + Stonefire mini naan"},
    {"name": "Meatball Subs",                  "rating": 4, "tags": ["kid-friendly"],                     "notes": "frozen meatballs + crescent rolls"},
    {"name": "Lit'l Smokies Pigs in Blankets", "rating": 4, "tags": ["quick","kid-friendly"],             "notes": "Hillshire Farm + Sweet Baby Ray's + crescent rolls"},
    {"name": "Hot Dogs",                       "rating": 4, "tags": ["quick","kid-friendly"],             "notes": "Nathan's beef hot dogs + Martin's Long Rolls"},
    {"name": "Beef Birria Tacos",              "rating": 4, "tags": ["quick"],                            "notes": "Del Real Foods slow-cooked — just heat and serve"},
    {"name": "Rigatoni with Chicken Sausage",  "rating": 4, "tags": [],                                   "notes": "Aidells Chicken Sausage with Mozzarella"},
    {"name": "Panera Soup Night",              "rating": 3, "tags": ["quick"],                            "notes": "Panera ready-to-heat soups — good for winter"},
    # ── Mexican & Tex-Mex ───────────────────────────────────────────────────
    {"name": "Chicken Enchiladas",             "rating": 4, "tags": ["comfort-food"],                     "notes": "rotisserie chicken + Old El Paso enchilada sauce + shredded cheese"},
    {"name": "Burrito Bowls",                  "rating": 4, "tags": ["quick"],                            "notes": "seasoned ground beef or chicken + rice + black beans + toppings"},
    {"name": "Chicken Fajitas",                "rating": 4, "tags": ["quick","kid-friendly"],             "notes": "Perdue thighs + bell peppers + onion + flour tortillas"},
    {"name": "Quesadillas",                    "rating": 4, "tags": ["quick","kid-friendly"],             "notes": "flour tortillas + shredded cheese + chicken — kids love building their own"},
    {"name": "Taco Soup",                      "rating": 4, "tags": ["quick","comfort-food"],             "notes": "ground beef + ROTEL + beans + corn + taco seasoning — one pot, 20 min"},
    {"name": "Beef Nachos",                    "rating": 3, "tags": ["quick","kid-friendly"],             "notes": "tortilla chips + seasoned ground beef + shredded cheese + ROTEL"},
    # ── Italian & Pasta ─────────────────────────────────────────────────────
    {"name": "Baked Ziti",                     "rating": 4, "tags": ["weekend","comfort-food"],           "notes": "like lasagna but easier — rigatoni + Rao's + ricotta + mozzarella"},
    {"name": "Pesto Pasta with Chicken",       "rating": 4, "tags": ["quick"],                            "notes": "jarred pesto + rotini + grilled chicken thighs + cherry tomatoes"},
    {"name": "Spaghetti Carbonara",            "rating": 4, "tags": ["quick"],                            "notes": "eggs + parmesan + pancetta or bacon — 20 min, no cream needed"},
    # ── American comfort ────────────────────────────────────────────────────
    {"name": "Sloppy Joes",                    "rating": 4, "tags": ["quick","kid-friendly"],             "notes": "Manwich + 80/20 ground beef + Martin's potato rolls — 15 min dinner"},
    {"name": "Shepherd's Pie",                 "rating": 4, "tags": ["weekend","comfort-food"],           "notes": "ground beef + frozen mixed veg + mashed potato topping"},
    {"name": "Chicken and Dumplings",          "rating": 4, "tags": ["comfort-food"],                     "notes": "rotisserie chicken + Grands biscuits as dumplings — hearty and quick"},
    {"name": "White Chicken Chili",            "rating": 4, "tags": ["comfort-food"],                     "notes": "rotisserie chicken + white beans + green chiles + cream cheese"},
    {"name": "Philly Cheesesteaks",            "rating": 4, "tags": ["kid-friendly"],                     "notes": "shaved beef + provolone + peppers + onions + hoagie rolls"},
    {"name": "French Dip Sandwiches",          "rating": 4, "tags": ["kid-friendly"],                     "notes": "chuck roast in slow cooker + au jus + provolone + hoagie rolls"},
    {"name": "BBQ Chicken",                    "rating": 4, "tags": ["weekend","kid-friendly"],           "notes": "Sweet Baby Ray's + Perdue thighs — oven-baked or grilled"},
    {"name": "Sheet Pan Chicken Thighs",       "rating": 4, "tags": ["kid-friendly"],                     "notes": "Perdue thighs + roasted potatoes and broccoli — one pan, minimal cleanup"},
    {"name": "Grilled Cheese and Tomato Soup", "rating": 4, "tags": ["quick","kid-friendly","comfort-food"],"notes": "Campbell's or Great Value tomato soup + thick-sliced buttered bread"},
    {"name": "Homemade Pizza Night",           "rating": 4, "tags": ["weekend","kid-friendly"],           "notes": "Pillsbury dough or Stonefire naan + sauce + toppings — kids build their own"},
    {"name": "Mac and Cheese with Hot Dogs",   "rating": 3, "tags": ["quick","kid-friendly"],             "notes": "Nathan's sliced into Kraft mac — reliable low-effort kid meal"},
    # ── Asian-inspired ──────────────────────────────────────────────────────
    {"name": "Teriyaki Chicken with Rice",     "rating": 4, "tags": ["quick","kid-friendly"],             "notes": "Kikkoman teriyaki + Perdue thighs + jasmine rice + broccoli"},
    {"name": "Chicken Fried Rice",             "rating": 4, "tags": ["quick"],                            "notes": "day-old rice + eggs + frozen peas + soy sauce + sesame oil"},
    {"name": "Beef and Broccoli",              "rating": 4, "tags": ["quick"],                            "notes": "flank steak or beef strips + frozen broccoli + soy-ginger sauce over rice"},
    {"name": "Lo Mein",                        "rating": 3, "tags": ["quick"],                            "notes": "lo mein noodles + frozen stir-fry veg + soy sauce + sesame oil"},
    # ── Breakfast for dinner ────────────────────────────────────────────────
    {"name": "Breakfast for Dinner",           "rating": 4, "tags": ["quick","kid-friendly"],             "notes": "scrambled eggs + bacon + Kodiak pancakes — big family hit, zero complaints"},
]


def _migrate_staples_from_prefs() -> None:
    prefs_path   = _dpath('prefs.json')
    staples_path = _dpath('staples.json')
    if os.path.exists(staples_path) or not os.path.exists(prefs_path):
        return
    try:
        with open(prefs_path, encoding='utf-8') as f:
            p = json.load(f)
        raw = p.get('weeklyStaples', [])
        if not raw:
            return
        base_ms  = int(time.time() * 1000)
        migrated = [
            {'id': str(base_ms + i), 'name': (item if isinstance(item, str) else item.get('name', str(item))),
             'qty': 1, 'unit': '', 'notes': ''}
            for i, item in enumerate(raw)
        ]
        with open(staples_path, 'w', encoding='utf-8') as f:
            json.dump(migrated, f, indent=2)
        p['weeklyStaples'] = []
        with open(prefs_path, 'w', encoding='utf-8') as f:
            json.dump(p, f, indent=2)
    except Exception:
        pass


def _check_session_reminder() -> None:
    try:
        with open(_dpath('prefs.json'), encoding='utf-8') as f:
            prefs = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return
    from datetime import date as _date
    due = prefs.get('nextSessionDue', '')
    if due and _date.fromisoformat(due) <= _date.today():
        print(f'[Grocery Agent] Planning session due — next session was due {due}.')


# ── Auth ──────────────────────────────────────────────────────────────────────

def _load_users() -> dict:
    try:
        with open(_USERS_PATH, encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {'users': {}}


def _save_users(data: dict) -> None:
    os.makedirs(os.path.dirname(_USERS_PATH), exist_ok=True)
    with open(_USERS_PATH, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)


def _init_user_data(username: str) -> None:
    """Create per-user data dir, migrate legacy root-level files on first login, seed defaults."""
    user_dir = os.path.join(_DATA_ROOT, 'users', username)
    os.makedirs(user_dir, exist_ok=True)

    # One-time migration: copy any legacy root-level data files into the user's dir
    for fname in ('recipes.json', 'pantry.json', 'prefs.json', 'staples.json',
                  'spend_history.json', 'meal_schedule.json', 'google_token.json'):
        legacy = os.path.join(_DATA_ROOT, fname)
        dest   = os.path.join(user_dir, fname)
        if os.path.exists(legacy) and not os.path.exists(dest):
            shutil.copy2(legacy, dest)

    # Seed or merge recipes
    recipes_path = os.path.join(user_dir, 'recipes.json')
    if os.path.exists(recipes_path):
        try:
            with open(recipes_path, encoding='utf-8') as f:
                existing = json.load(f)
            existing_names = {r['name'].lower() for r in existing}
            base_id = int(time.time() * 1000)
            to_add  = [
                {**r, 'id': str(base_id + i), 'timesPlanned': 0, 'lastPlanned': ''}
                for i, r in enumerate(_SEED_RECIPES)
                if r['name'].lower() not in existing_names
            ]
            if to_add:
                with open(recipes_path, 'w', encoding='utf-8') as f:
                    json.dump(existing + to_add, f, indent=2)
        except Exception:
            pass
    else:
        base_id = int(time.time() * 1000)
        seeded  = [{**r, 'id': str(base_id + i), 'timesPlanned': 0, 'lastPlanned': ''}
                   for i, r in enumerate(_SEED_RECIPES)]
        with open(recipes_path, 'w', encoding='utf-8') as f:
            json.dump(seeded, f, indent=2)

    # Seed empty prefs if none exist yet
    prefs_path = os.path.join(user_dir, 'prefs.json')
    if not os.path.exists(prefs_path):
        with open(prefs_path, 'w', encoding='utf-8') as f:
            json.dump({}, f, indent=2)

    # One-time staples migration: prefs.weeklyStaples strings → staples.json objects
    staples_path = os.path.join(user_dir, 'staples.json')
    if not os.path.exists(staples_path) and os.path.exists(prefs_path):
        try:
            with open(prefs_path, encoding='utf-8') as f:
                p = json.load(f)
            raw = p.get('weeklyStaples', [])
            if raw:
                base_ms  = int(time.time() * 1000)
                migrated = []
                for i, item in enumerate(raw):
                    name = item if isinstance(item, str) else item.get('name', str(item))
                    migrated.append({'id': str(base_ms + i), 'name': name, 'qty': 1, 'unit': '', 'notes': ''})
                with open(staples_path, 'w', encoding='utf-8') as f:
                    json.dump(migrated, f, indent=2)
                p['weeklyStaples'] = []
                with open(prefs_path, 'w', encoding='utf-8') as f:
                    json.dump(p, f, indent=2)
                print(f"  Migrated {len(migrated)} weekly staples → staples.json for {username}")
        except Exception:
            pass


_AUTH_EXEMPT = {'/login', '/logout', '/register', '/ping', '/api/mode', '/feedback', '/me', '/manifest.json', '/service-worker.js'}


@app.before_request
def _require_auth():
    if request.path in _AUTH_EXEMPT or request.path.startswith('/static/'):
        return None
    if not session.get('username'):
        if request.method == 'GET':
            return redirect('/login')
        return jsonify({'error': 'not authenticated'}), 401


# ── Static / PWA ──────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory('static', 'index.html')

@app.route('/manifest.json')
def manifest():
    return send_from_directory('static', 'manifest.json', mimetype='application/manifest+json')

@app.route('/service-worker.js')
def service_worker():
    sw_path = os.path.join(os.path.dirname(__file__), 'static', 'service-worker.js')
    with open(sw_path, encoding='utf-8') as f:
        content = f.read()
    content = re.sub(r"const CACHE = '[^']*'", f"const CACHE = 'grocery-agent-{_SERVER_START}'", content)
    resp = Response(content, mimetype='application/javascript')
    resp.headers['Service-Worker-Allowed'] = '/'
    return resp


@app.route('/ping')
def ping():
    return jsonify({"ok": True})


@app.route('/api/mode')
def api_mode():
    return jsonify({"mode": "demo" if _DEMO_MODE else "live"})


@app.route('/feedback', methods=['POST'])
def submit_feedback():
    body = request.json or {}
    entry = {
        'timestamp': datetime.utcnow().isoformat(),
        'type': body.get('type', 'other'),
        'message': body.get('message', '').strip(),
    }
    if not entry['message']:
        return jsonify({'error': 'message required'}), 400
    path = _dpath('feedback.json')
    try:
        with open(path, encoding='utf-8') as f:
            items = json.load(f)
    except Exception:
        items = []
    items.append(entry)
    os.makedirs(_data_dir(), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(items, f, indent=2)
    return jsonify({'ok': True})


@app.route('/week-glance')
def week_glance():
    """Aggregated data for the week-at-a-glance dashboard."""
    try:
        with open(_dpath('prefs.json'), encoding='utf-8') as f:
            prefs_data = json.load(f)
    except Exception:
        prefs_data = {}

    pantry = _load_pantry()
    day_order = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

    # Build meal map from lastWeekMeals: {day_name: {meal, isOut}}
    last_meals = prefs_data.get('lastWeekMeals', [])
    meal_map = {m['day']: m for m in last_meals if m.get('day')}

    # Determine the Sunday that starts the planned week from mealHistory
    meal_history = prefs_data.get('mealHistory', [])
    week_sunday_iso = None
    if meal_history:
        try:
            from datetime import date as _date
            planning_date = _date.fromisoformat(meal_history[-1]['week'])
            wd = planning_date.weekday()  # 0=Mon … 6=Sun
            week_sunday_iso = (planning_date - timedelta(days=(wd + 1) % 7)).isoformat()
        except Exception:
            pass

    # Build per-day data list
    days_data = []
    for i, day_name in enumerate(day_order):
        m = meal_map.get(day_name, {})
        day_entry = {
            'day': day_name,
            'dayAbbr': day_name[:3],
            'date': None,
            'dayNum': None,
            'month': None,
            'meal': m.get('meal', ''),
            'isOut': m.get('meal', '') == 'Out',
            'isLeftovers': m.get('meal', '') == 'Leftovers',
        }
        if week_sunday_iso:
            try:
                from datetime import date as _date
                d = _date.fromisoformat(week_sunday_iso) + timedelta(days=i)
                day_entry['date'] = d.isoformat()
                day_entry['dayNum'] = d.day
                day_entry['month'] = d.strftime('%b')
            except Exception:
                pass
        days_data.append(day_entry)

    # Collect ingredient text from recipes planned this week (for filtering)
    planned_meal_names = {
        m.get('meal', '').strip().lower() for m in last_meals
        if m.get('meal') and m.get('meal') != 'Out'
    }
    planned_ingredient_text = []
    try:
        with open(_dpath('recipes.json'), encoding='utf-8') as f:
            all_recipes = json.load(f)
        for recipe in all_recipes:
            if recipe.get('name', '').strip().lower() in planned_meal_names:
                planned_ingredient_text.extend(
                    ing.lower() for ing in recipe.get('ingredients', [])
                )
    except Exception:
        pass

    def _already_in_plan(item_name: str) -> bool:
        name_lower = item_name.lower().strip()
        return any(name_lower in ing for ing in planned_ingredient_text)

    # Expiring pantry items (within 7 days), excluding those already in a planned recipe
    today_date = datetime.now().date()
    expiring = []
    for item in pantry:
        if item.get('expiresOn'):
            try:
                from datetime import date as _date
                exp = _date.fromisoformat(item['expiresOn'])
                days_left = (exp - today_date).days
                if days_left <= 7 and not _already_in_plan(item.get('name', '')):
                    expiring.append({
                        'name': item.get('name', ''),
                        'amount': item.get('amount', ''),
                        'unit': item.get('unit', ''),
                        'daysLeft': days_left,
                    })
            except Exception:
                pass
    expiring.sort(key=lambda x: x['daysLeft'])

    # Calendar events — best effort, silent on any failure
    calendar_events = None
    if _GCAL_AVAILABLE:
        try:
            creds = _load_google_creds()
            if creds:
                if creds.expired and creds.refresh_token:
                    creds.refresh(GRequest())
                    _save_google_creds(creds)
                tz_name = prefs_data.get('timezone') or 'America/Denver'
                try:
                    tz = ZoneInfo(tz_name)
                except Exception:
                    tz = ZoneInfo('America/Denver')
                service = gcal_build('calendar', 'v3', credentials=creds)
                now = datetime.now(tz)
                monday = now - timedelta(days=now.weekday())
                sunday = monday + timedelta(days=6)
                time_min = monday.replace(hour=0,  minute=0,  second=0,  microsecond=0).isoformat()
                time_max = sunday.replace(hour=23, minute=59, second=59, microsecond=0).isoformat()
                result = service.events().list(
                    calendarId='primary', timeMin=time_min, timeMax=time_max,
                    timeZone=tz_name, singleEvents=True, orderBy='startTime', maxResults=50
                ).execute()
                calendar_events = {d: [] for d in day_order}
                for event in result.get('items', []):
                    start  = event.get('start', {})
                    dt_str = start.get('dateTime') or start.get('date')
                    if not dt_str:
                        continue
                    try:
                        if start.get('dateTime'):
                            dt     = datetime.fromisoformat(dt_str).astimezone(tz)
                            h, m   = dt.hour, dt.minute
                            ap     = 'am' if h < 12 else 'pm'
                            h12    = h % 12 or 12
                            tstr   = f"{h12}:{m:02d}{ap}" if m else f"{h12}{ap}"
                        else:
                            dt   = datetime.fromisoformat(dt_str)
                            tstr = 'all day'
                        dn = dt.strftime('%A')
                        if dn in calendar_events:
                            calendar_events[dn].append({'time': tstr, 'title': event.get('summary', '')})
                    except Exception:
                        continue
        except Exception:
            calendar_events = None

    return jsonify({
        'days': days_data,
        'weekMonday': week_monday_iso,
        'calendarEvents': calendar_events,
        'expiringPantry': expiring,
        'breakfasts': prefs_data.get('defaultBreakfasts', []),
        'lunches': prefs_data.get('defaultLunches', []),
        'dessert': prefs_data.get('defaultDessert', ''),
    })


@app.route('/dashboard/meal', methods=['PATCH'])
def dashboard_update_meal():
    """Update a single day's dinner from the dashboard."""
    body = request.json or {}
    day  = body.get('day', '').strip()
    meal = body.get('meal', '').strip()
    if not day:
        return jsonify({'error': 'day required'}), 400
    try:
        with open(_dpath('prefs.json'), encoding='utf-8') as f:
            prefs = json.load(f)
    except Exception:
        prefs = {}
    meals = prefs.get('lastWeekMeals', [])
    found = False
    for m in meals:
        if m.get('day') == day:
            m['meal'] = meal
            m['isOut'] = meal == 'Out'
            m['isLeftovers'] = meal == 'Leftovers'
            found = True
            break
    if not found:
        meals.append({'day': day, 'meal': meal, 'isOut': meal == 'Out', 'isLeftovers': meal == 'Leftovers', 'easyMode': False})
    prefs['lastWeekMeals'] = meals
    os.makedirs(_data_dir(), exist_ok=True)
    with open(_dpath('prefs.json'), 'w', encoding='utf-8') as f:
        json.dump(prefs, f, indent=2)
    return jsonify({'ok': True})


@app.route('/dashboard/meta', methods=['PATCH'])
def dashboard_update_meta():
    """Update breakfast / lunch / dessert for the week from the dashboard."""
    body = request.json or {}
    try:
        with open(_dpath('prefs.json'), encoding='utf-8') as f:
            prefs = json.load(f)
    except Exception:
        prefs = {}
    for key in ('defaultBreakfasts', 'defaultLunches', 'defaultDessert'):
        if key in body:
            prefs[key] = body[key]
    os.makedirs(_data_dir(), exist_ok=True)
    with open(_dpath('prefs.json'), 'w', encoding='utf-8') as f:
        json.dump(prefs, f, indent=2)
    return jsonify({'ok': True})


@app.route('/dashboard/pantry-ideas', methods=['POST'])
def dashboard_pantry_ideas():
    """Return Claude suggestions for how to use an expiring pantry item."""
    body = request.json or {}
    item = body.get('item', '').strip()
    planned = body.get('plannedMeals', [])
    expires_in = body.get('expiresIn', 7)
    if not item:
        return jsonify({'error': 'item required'}), 400

    # Load past feedback to steer Claude's suggestions
    all_feedback = _load_pantry_feedback()
    item_feedback = [f for f in all_feedback if f.get('item', '').lower() == item.lower()]
    liked    = [f['idea'] for f in item_feedback if f.get('rating') == 1]
    disliked = [f['idea'] for f in item_feedback if f.get('rating') == -1]

    urgency = ('today' if expires_in <= 0
               else 'tomorrow' if expires_in == 1
               else f'in {expires_in} days')
    planned_str = ', '.join(planned) if planned else 'nothing specific yet'
    feedback_ctx = ''
    if liked:
        feedback_ctx += f' Previously well-received ideas: {"; ".join(liked[:3])}.'
    if disliked:
        feedback_ctx += f' Avoid ideas similar to these previously rejected ones: {"; ".join(disliked[:3])}.'

    prompt = (
        f"We have {item} in our pantry that expires {urgency}. "
        f"This week we're already planning: {planned_str}.{feedback_ctx} "
        f"Give 3 quick, practical ideas for how to use the {item} this week. "
        f"Be specific and brief — one sentence each. "
        f"Plain numbered list, no headers, no preamble."
    )
    try:
        client = anthropic.Anthropic(api_key=os.getenv('ANTHROPIC_API_KEY'))
        msg = client.messages.create(
            model=MODEL, max_tokens=300,
            messages=[{'role': 'user', 'content': prompt}]
        )
        return jsonify({
            'ideas': msg.content[0].text,
            'feedback': [{'idea': f['idea'], 'rating': f['rating']} for f in item_feedback],
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/dashboard/pantry-feedback', methods=['POST'])
def dashboard_pantry_feedback():
    """Save thumbs-up / thumbs-down on a pantry idea."""
    body   = request.json or {}
    item   = body.get('item', '').strip()
    idea   = body.get('idea', '').strip()
    rating = body.get('rating')  # 1, -1, or 0 (0 = remove)
    if not item or not idea or rating not in (1, -1, 0):
        return jsonify({'error': 'item, idea, and rating (1/-1/0) required'}), 400
    feedback = _load_pantry_feedback()
    # Remove any prior rating for this exact item+idea pair
    feedback = [f for f in feedback
                if not (f.get('item', '').lower() == item.lower() and f.get('idea') == idea)]
    if rating != 0:
        feedback.append({'item': item, 'idea': idea, 'rating': rating,
                         'timestamp': datetime.now().isoformat()})
    _save_pantry_feedback(feedback)
    return jsonify({'ok': True})


# ── Auth routes ───────────────────────────────────────────────────────────────

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'GET':
        if session.get('username'):
            return redirect('/')
        return send_from_directory('static', 'login.html')
    data       = request.json or {}
    username   = (data.get('username') or '').strip().lower()
    password   = data.get('password', '')
    users_data = _load_users()
    user       = users_data['users'].get(username)
    if user and check_password_hash(user['password'], password):
        session['username'] = username
        _init_user_data(username)
        return jsonify({'ok': True})
    return jsonify({'error': 'Invalid username or password'}), 401


@app.route('/me', methods=['GET'])
def me():
    return jsonify({'username': session.get('username', '')})


@app.route('/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({'ok': True})


@app.route('/change-password', methods=['POST'])
def change_password():
    username = session.get('username')
    if not username:
        return jsonify({'error': 'not authenticated'}), 401
    data       = request.json or {}
    current_pw = data.get('currentPassword', '')
    new_pw     = data.get('newPassword', '')
    if not current_pw or not new_pw:
        return jsonify({'error': 'currentPassword and newPassword required'}), 400
    if len(new_pw) < 6:
        return jsonify({'error': 'New password must be at least 6 characters'}), 400
    users_data = _load_users()
    user       = users_data['users'].get(username)
    if not user or not check_password_hash(user.get('password', ''), current_pw):
        return jsonify({'error': 'Current password is incorrect'}), 401
    users_data['users'][username]['password'] = generate_password_hash(new_pw)
    _save_users(users_data)
    return jsonify({'ok': True})


@app.route('/register', methods=['POST'])
def register():
    data     = request.json or {}
    username = (data.get('username') or '').strip().lower()
    password = data.get('password', '')
    invite   = (data.get('invite') or '').strip()
    if not username or not password:
        return jsonify({'error': 'username and password required'}), 400
    if len(username) < 2 or not re.match(r'^[a-z0-9_-]+$', username):
        return jsonify({'error': 'username must be 2+ lowercase letters, numbers, _ or -'}), 400
    if len(password) < 6:
        return jsonify({'error': 'password must be at least 6 characters'}), 400
    users_data = _load_users()
    # First registration needs no invite code — lets the owner set up their account
    if users_data['users']:
        valid_codes = [c.strip() for c in os.getenv('INVITE_CODES', '').split(',') if c.strip()]
        if not invite or invite not in valid_codes:
            return jsonify({'error': 'An invite code is required'}), 403
    if username in users_data['users']:
        return jsonify({'error': 'Username already taken'}), 409
    users_data['users'][username] = {
        'password':   generate_password_hash(password),
        'created_at': datetime.now().isoformat(),
    }
    _save_users(users_data)
    _init_user_data(username)
    session['username'] = username
    return jsonify({'ok': True})


@app.route('/auth/me')
def auth_me():
    return jsonify({'username': session.get('username', '')})


# ── Household / Prefs ─────────────────────────────────────────────────────────

@app.route('/household-items', methods=['GET'])
def get_household_items():
    try:
        with open(_dpath('prefs.json'), encoding='utf-8') as f:
            p = json.load(f)
        if p.get('householdItems'):
            return jsonify({'items': p['householdItems']})
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return jsonify({'items': []})


@app.route('/prefs', methods=['GET'])
def get_prefs():
    try:
        with open(_dpath('prefs.json'), encoding='utf-8') as f:
            return jsonify(json.load(f))
    except (FileNotFoundError, json.JSONDecodeError):
        return jsonify({})


@app.route('/prefs', methods=['POST'])
def save_prefs():
    data = request.json
    if not isinstance(data, dict):
        return jsonify({'error': 'invalid prefs payload'}), 400
    os.makedirs(_data_dir(), exist_ok=True)
    with open(_dpath('prefs.json'), 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)
    return jsonify({'ok': True})


@app.route('/spend-history', methods=['GET'])
def get_spend_history():
    try:
        with open(_dpath('spend_history.json'), encoding='utf-8') as f:
            return jsonify(json.load(f))
    except (FileNotFoundError, json.JSONDecodeError):
        return jsonify([])


@app.route('/spend-history', methods=['POST'])
def add_spend_history():
    body       = request.json or {}
    date       = (body.get('date') or '').strip()
    total      = float(body.get('total') or 0)
    meal_count = int(body.get('mealCount') or 0)
    if not date or total <= 0:
        return jsonify({'error': 'date and positive total required'}), 400
    try:
        with open(_dpath('spend_history.json'), encoding='utf-8') as f:
            history = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        history = []
    history.append({'date': date, 'total': round(total, 2), 'mealCount': meal_count})
    history = history[-52:]  # cap at one year
    os.makedirs(_data_dir(), exist_ok=True)
    with open(_dpath('spend_history.json'), 'w', encoding='utf-8') as f:
        json.dump(history, f, indent=2)
    return jsonify({'ok': True})


@app.route('/spend-history', methods=['DELETE'])
def delete_spend_history_entry():
    date_str = (request.json or {}).get('date', '')
    if not date_str:
        return jsonify({'error': 'date required'}), 400
    try:
        with open(_dpath('spend_history.json'), encoding='utf-8') as f:
            history = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        history = []
    history = [h for h in history if h.get('date') != date_str]
    os.makedirs(_data_dir(), exist_ok=True)
    with open(_dpath('spend_history.json'), 'w', encoding='utf-8') as f:
        json.dump(history, f, indent=2)
    return '', 204


# ── Pantry ────────────────────────────────────────────────────────────────────

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


@app.route('/pantry/batch', methods=['POST'])
def batch_add_pantry():
    bodies = (request.json or {}).get('items', [])
    if not bodies:
        return jsonify({'added': 0, 'items': []})
    pantry = _load_pantry()
    added = []
    base_ms = int(time.time() * 1000)
    for i, body in enumerate(bodies):
        name = (body.get('name') or '').strip()
        if not name:
            continue
        item = {
            'id':        str(base_ms + i),
            'name':      name,
            'amount':    body.get('amount', ''),
            'unit':      body.get('unit', ''),
            'expiresOn': body.get('expiresOn', ''),
            'addedOn':   body.get('addedOn', ''),
        }
        pantry.append(item)
        added.append(item)
    _save_pantry(pantry)
    return jsonify({'added': len(added), 'items': added})


# ── Recipes ───────────────────────────────────────────────────────────────────

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


@app.route('/recipes/url', methods=['POST'])
def import_recipe_from_url():
    from html.parser import HTMLParser
    url = (request.json or {}).get('url', '').strip()
    if not url:
        return jsonify({'error': 'url required'}), 400
    try:
        r = requests.get(url, timeout=15,
            headers={'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'})
        r.raise_for_status()
    except Exception as e:
        return jsonify({'error': f'Could not fetch URL: {e}'}), 400

    class _Stripper(HTMLParser):
        def __init__(self): super().__init__(); self.fed = []
        def handle_data(self, d): self.fed.append(d)
        def get_data(self): return ' '.join(self.fed)
    s = _Stripper()
    s.feed(r.text)
    page_text = s.get_data()[:8000]

    try:
        msg = client.messages.create(model=MODEL, max_tokens=1024, messages=[{
            'role': 'user',
            'content': (
                'Extract the recipe from this webpage. Return JSON only, no markdown:\n'
                '{"name":"...","ingredients":["1 cup flour",...],"steps":["Preheat oven...",...],"tags":[]}\n\n'
                'Tags must be from: quick, weekend, kid-friendly, comfort-food, dessert\n\n'
                f'Page text:\n{page_text}'
            )
        }])
        raw = msg.content[0].text.strip()
        if raw.startswith('```'):
            raw = raw.split('\n', 1)[1].rsplit('```', 1)[0]
        data = json.loads(raw)
    except Exception as e:
        return jsonify({'error': f'Could not parse recipe: {e}'}), 500

    recipe = {
        'id': str(int(time.time() * 1000)),
        'name': data.get('name', 'Imported Recipe'),
        'rating': 0, 'timesPlanned': 0, 'lastPlanned': '',
        'tags': data.get('tags', []),
        'notes': f'imported from {url}',
        'ingredients': data.get('ingredients', []),
        'steps': data.get('steps', []),
        'photo': None,
    }
    recipes = _load_recipes()
    recipes.append(recipe)
    _save_recipes(recipes)
    return jsonify({'ok': True, 'recipe': recipe})


@app.route('/recipes/batch-rate', methods=['POST'])
def batch_rate_recipes():
    ratings = (request.json or {}).get('ratings', [])
    if not ratings:
        return jsonify({'ok': True})
    recipes = _load_recipes()
    today = datetime.now().strftime('%Y-%m-%d')
    base_ms = int(time.time() * 1000)
    new_count = 0
    for entry in ratings:
        name = (entry.get('name') or '').strip()
        rating = entry.get('rating', 0)
        if not name:
            continue
        for r in recipes:
            if r['name'].lower() == name.lower():
                r['timesPlanned'] = r.get('timesPlanned', 0) + 1
                r['lastPlanned'] = today
                if rating:
                    r['rating'] = rating
                break
        else:
            recipes.append({
                'id': str(base_ms + new_count),
                'name': name,
                'rating': rating,
                'tags': [],
                'notes': '',
                'timesPlanned': 1,
                'lastPlanned': today,
            })
            new_count += 1
    _save_recipes(recipes)
    return jsonify({'ok': True})


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


@app.route('/recipes/photo', methods=['POST'])
def upload_recipe_photo():
    recipe_id = request.form.get('recipe_id', '').strip()
    f = request.files.get('file')
    if not recipe_id or not f:
        return jsonify({'error': 'missing recipe_id or file'}), 400
    ext = os.path.splitext(f.filename)[1].lower()
    if ext not in {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif'}:
        ext = '.jpg'
    photos = _photos_dir()
    os.makedirs(photos, exist_ok=True)
    filename = f'{recipe_id}{ext}'
    f.save(os.path.join(photos, filename))
    username = session.get('username', 'default')
    url = f'/static/photos/{username}/{filename}'
    recipes = _load_recipes()
    for r in recipes:
        if r['id'] == recipe_id:
            r['photo'] = url
            _save_recipes(recipes)
            return jsonify({'url': url})
    return jsonify({'error': 'recipe not found'}), 404


def _ingredient_to_str(ing) -> str:
    if isinstance(ing, str):
        return ing
    qty  = ing.get('quantity', '')
    unit = ing.get('unit', '')
    name = ing.get('name', '')
    parts = [str(qty) if qty else '', unit, name]
    return ' '.join(p for p in parts if p).strip()


def _generate_recipe_content(recipe: dict, client) -> tuple:
    prompt = f"""For the recipe "{recipe['name']}", return a JSON object with two keys:
- "ingredients": array of plain strings for a family of 4.
  Use standard US kitchen units ONLY: cups, tablespoons (tbsp), teaspoons (tsp),
  pounds (lb), ounces (oz), fluid ounces (fl oz), quarts, gallons, whole counts,
  cans (with size in oz), cloves. Do NOT use metric units (g, kg, ml, L).
  Examples: "1.5 lb ground beef", "2 cups shredded cheddar", "1 tbsp olive oil",
  "1 can (14.5 oz) diced tomatoes", "3 cloves garlic"
- "steps": array of short step strings (4–8 steps)

Return ONLY the JSON object, no markdown, no extra text.
Notes: {recipe.get('notes', '')}"""
    try:
        msg = client.messages.create(
            model=MODEL,
            max_tokens=1000,
            messages=[{'role': 'user', 'content': prompt}]
        )
        text = msg.content[0].text.strip().replace('```json', '').replace('```', '').strip()
        data = json.loads(text)
        ings  = [_ingredient_to_str(i) for i in data.get('ingredients', [])]
        steps = [str(s) for s in data.get('steps', [])]
        return recipe['id'], ings, steps
    except Exception:
        return recipe['id'], [], []


@app.route('/recipes/backfill', methods=['POST'])
def backfill_recipes():
    recipes = _load_recipes()
    force = (request.json or {}).get('force', False)

    converted = 0
    for r in recipes:
        ings = r.get('ingredients')
        if ings and any(isinstance(i, dict) for i in ings):
            r['ingredients'] = [_ingredient_to_str(i) for i in ings]
            converted += 1

    to_fill = recipes if force else [r for r in recipes if not r.get('ingredients')]
    if not to_fill and converted == 0:
        return jsonify({'filled': 0, 'total': len(recipes)})

    api_key = os.getenv('ANTHROPIC_API_KEY')
    if not api_key:
        return jsonify({'error': 'ANTHROPIC_API_KEY not set'}), 500

    client = anthropic.Anthropic(api_key=api_key)
    filled = 0
    recipe_map = {r['id']: r for r in recipes}

    with ThreadPoolExecutor(max_workers=8) as ex:
        futures = {ex.submit(_generate_recipe_content, r, client): r['id'] for r in to_fill}
        for future in as_completed(futures):
            rid, ingredients, steps = future.result()
            if ingredients:
                recipe_map[rid]['ingredients'] = ingredients
                recipe_map[rid]['steps'] = steps
                filled += 1

    _save_recipes(list(recipe_map.values()))
    return jsonify({'filled': filled, 'converted': converted, 'total': len(recipes)})


@app.route('/recipes/<recipe_id>/regenerate', methods=['POST'])
def regenerate_recipe(recipe_id):
    try:
        recipes = _load_recipes()
        recipe = next((r for r in recipes if r['id'] == recipe_id), None)
        if not recipe:
            return jsonify({'error': 'Recipe not found'}), 404

        api_key = os.getenv('ANTHROPIC_API_KEY')
        if not api_key:
            return jsonify({'error': 'ANTHROPIC_API_KEY not set'}), 500

        client = anthropic.Anthropic(api_key=api_key)
        _, ingredients, steps = _generate_recipe_content(recipe, client)
        if not ingredients:
            return jsonify({'error': 'Claude failed to generate content'}), 500

        recipe['ingredients'] = ingredients
        recipe['steps'] = steps
        _save_recipes(recipes)
        return jsonify(recipe)
    except Exception:
        traceback.print_exc()
        return jsonify({'error': 'server error'}), 500


# ── Claude endpoints ──────────────────────────────────────────────────────────

@app.route('/claude-prompt', methods=['POST'])
def claude_prompt():
    prompt = (request.json or {}).get('prompt', '').strip()
    if not prompt:
        return jsonify({'error': 'prompt required'}), 400
    try:
        client = anthropic.Anthropic(api_key=os.getenv('ANTHROPIC_API_KEY'))
        msg = client.messages.create(
            model=MODEL,
            max_tokens=800,
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
Also avoid dishes that share the same base format as the meals already planned (e.g., if pasta is already planned, do not suggest another pasta dish; if tacos are planned, avoid other taco variations).
Family: kid-friendly comfort food, chicken, pasta, tacos, American/Italian/Mexican cuisine, practical weeknight meals.
Return ONLY the recipe name — no explanation, no punctuation, just the name."""
    try:
        client = anthropic.Anthropic(api_key=os.getenv('ANTHROPIC_API_KEY'))
        msg = client.messages.create(
            model=MODEL, max_tokens=30,
            messages=[{'role': 'user', 'content': prompt}]
        )
        name = msg.content[0].text.strip().strip('"\'.')
        return jsonify({'meal': name})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


# ── iCloud extras queue ───────────────────────────────────────────────────────

_ICLOUD_EXTRAS = os.getenv('EXTRAS_QUEUE_PATH') or os.path.expanduser('~/iCloudDrive/grocery_extras.txt')


@app.route('/extras-queue', methods=['GET'])
def get_extras_queue():
    path = _ICLOUD_EXTRAS
    exists = os.path.isfile(path)
    try:
        with open(path, encoding='utf-8-sig') as f:
            items = [l.strip() for l in f if l.strip()]
    except FileNotFoundError:
        items = []
    if items:
        open(path, 'w', encoding='utf-8').close()
    return jsonify({'items': items, 'path': path, 'exists': exists, 'hint': not exists})


# ── Staples ───────────────────────────────────────────────────────────────────

@app.route('/staples', methods=['GET'])
def get_staples():
    return jsonify({'items': _load_staples()})


@app.route('/staples', methods=['POST'])
def add_staple():
    body = request.json or {}
    name = (body.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'name required'}), 400
    staples = _load_staples()
    item = {
        'id':    str(int(time.time() * 1000)),
        'name':  name,
        'qty':   body.get('qty', 1),
        'unit':  (body.get('unit') or '').strip(),
        'notes': (body.get('notes') or '').strip(),
    }
    staples.append(item)
    _save_staples(staples)
    return jsonify(item), 201


@app.route('/staples/<item_id>', methods=['PATCH'])
def update_staple(item_id):
    staples = _load_staples()
    for item in staples:
        if item['id'] == item_id:
            for field in ('name', 'qty', 'unit', 'notes', 'itemId', 'productName', 'lastPrice'):
                if field in (request.json or {}):
                    item[field] = request.json[field]
            _save_staples(staples)
            return jsonify(item)
    return jsonify({'error': 'not found'}), 404


@app.route('/staples/<item_id>', methods=['DELETE'])
def delete_staple(item_id):
    _save_staples([s for s in _load_staples() if s['id'] != item_id])
    return jsonify({'ok': True})


@app.route('/staples/reorder', methods=['POST'])
def reorder_staples():
    ids = (request.json or {}).get('ids', [])
    if not ids:
        return jsonify({'ok': True})
    staples = _load_staples()
    by_id = {s['id']: s for s in staples}
    reordered = [by_id[i] for i in ids if i in by_id]
    in_ids = set(ids)
    reordered += [s for s in staples if s['id'] not in in_ids]
    _save_staples(reordered)
    return jsonify({'ok': True})


# ── Picker / meal helpers ─────────────────────────────────────────────────────

@app.route('/picker-clarify', methods=['POST'])
def picker_clarify():
    data      = request.json or {}
    item_type = (data.get('type') or 'food').strip()
    name      = (data.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'name required'}), 400
    try:
        client = anthropic.Anthropic(api_key=os.getenv('ANTHROPIC_API_KEY'))
        msg = client.messages.create(
            model=MODEL,
            max_tokens=150,
            messages=[{
                'role': 'user',
                'content': (
                    f'A user planning their weekly {item_type} typed "{name}".\n'
                    'Ask ONE short clarifying question to understand exactly what product or version they want.\n'
                    'Return ONLY a JSON object:\n'
                    '{"question": "one short question?", "options": ["Option A", "Option B", "Option C"]}\n'
                    'Keep options to 2-4 short practical choices (e.g. homemade vs frozen, flavor, brand).\n'
                    f'If the name is already specific enough, return {{"question": null, "options": []}}.'
                ),
            }],
        )
        text = msg.content[0].text.strip().replace('```json', '').replace('```', '').strip()
        return jsonify(json.loads(text))
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/save-meal-schedule', methods=['POST'])
def save_meal_schedule():
    entries = (request.json or {}).get('schedule', [])
    if not isinstance(entries, list):
        return jsonify({'error': 'schedule must be a list'}), 400
    os.makedirs(_data_dir(), exist_ok=True)
    with open(_dpath('meal_schedule.json'), 'w', encoding='utf-8') as f:
        json.dump(entries, f, indent=2)
    return jsonify({'ok': True, 'saved': len(entries)})


@app.route('/generate-prep-list', methods=['POST'])
def generate_prep_list():
    data    = request.json or {}
    meals   = data.get('meals', [])
    pantry  = data.get('pantry', [])

    meal_lines = '\n'.join(
        f"  {m.get('day','')}: {m.get('meal','')} ({m.get('complexity','normal')} night)"
        for m in meals if not m.get('isOut') and not m.get('isLeftovers')
    )
    pantry_lines = ', '.join(m.get('name','') for m in pantry[:20]) or 'not specified'

    prompt = f"""You are a meal-prep assistant for a busy family of 4 (2 adults, a 10-year-old, and a toddler) in Livingston, MT.
Dinner is at 5:30pm every night. They cook most meals from scratch but use store-bought shortcuts on quick nights.

This week's dinner plan:
{meal_lines}

Pantry on hand (sample): {pantry_lines}

Generate a practical Sunday evening meal-prep guide. Return ONLY valid JSON in this exact format:
{{
  "sections": [
    {{
      "title": "Cook tonight (Sunday)",
      "tasks": ["<one-line task>", ...]
    }},
    {{
      "title": "Prep tonight",
      "tasks": ["<one-line task>", ...]
    }},
    {{
      "title": "Thaw schedule",
      "tasks": ["<day>: <what to move from freezer to fridge>", ...]
    }},
    {{
      "title": "Weekday lunch & snack prep",
      "tasks": ["<one-line task>", ...]
    }}
  ]
}}

Rules:
- Only include a section if there are actual tasks for it (skip empty sections)
- Be specific to the meals listed above — no generic advice
- Thaw tasks: name the specific item and which night it's for
- Cook/prep tasks: say which dinners the prepped ingredient will be used in
- Keep each task to one clear sentence
- Maximum 4 tasks per section"""

    try:
        client = anthropic.Anthropic(api_key=os.getenv('ANTHROPIC_API_KEY'))
        msg = client.messages.create(
            model=MODEL, max_tokens=800,
            messages=[{'role': 'user', 'content': prompt}]
        )
        text = msg.content[0].text.strip().replace('```json', '').replace('```', '').strip()
        return jsonify(json.loads(text))
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/generate-monthly-summary', methods=['POST'])
def generate_monthly_summary():
    try:
        with open(_dpath('prefs.json'), encoding='utf-8') as f:
            prefs = json.load(f)
    except Exception:
        prefs = {}
    try:
        with open(_dpath('spend_history.json'), encoding='utf-8') as f:
            spend_history = json.load(f)
    except Exception:
        spend_history = []
    try:
        with open(_dpath('staples.json'), encoding='utf-8') as f:
            staples = json.load(f)
    except Exception:
        staples = []

    recent_spend   = spend_history[-8:]
    meal_history   = prefs.get('mealHistory', [])
    household      = prefs.get('household', {})
    brand_rules    = prefs.get('brandRules', [])
    dietary_notes  = prefs.get('dietaryNotes', [])
    budget_target  = household.get('budgetTarget', 175)
    budget_max     = household.get('budgetMax', 225)

    spend_lines = '\n'.join(
        f"  Week of {w['date']}: ${w['total']:.2f} ({w['mealCount']} meals)"
        for w in recent_spend
    ) or '  No spend data available'

    meal_lines = '\n'.join(
        f"  Week of {w['week']}: {', '.join(w.get('meals', []))}"
        for w in meal_history
    ) or '  No meal history available'

    staple_names = ', '.join(s.get('name', '') for s in staples[:20]) or 'none recorded'
    brand_lines  = ', '.join(f"{r['item']} → {r['brand']}" for r in brand_rules) or 'none set'
    diet_lines   = ', '.join(dietary_notes) or 'none'

    prompt = f"""You are a grocery and meal planning analyst for a family of 4 in Livingston, MT.
Budget: target ${budget_target}/week, max ${budget_max}/week.

RECENT SPEND (last 8 weeks):
{spend_lines}

MEAL HISTORY (recent weeks):
{meal_lines}

WEEKLY STAPLES: {staple_names}
BRAND PREFERENCES: {brand_lines}
DIETARY NOTES: {diet_lines}

Generate a concise monthly planning summary. Return ONLY valid JSON:
{{
  "sections": [
    {{"title": "Meals this month", "tasks": ["specific observation about meal rotation and variety"]}},
    {{"title": "Spend trend", "tasks": ["specific observation about spending vs budget"]}},
    {{"title": "Recurring staples", "tasks": ["observation about staple patterns or brand consistency"]}},
    {{"title": "Recommendations", "tasks": ["specific, actionable suggestion for next month"]}}
  ]
}}

Rules:
- Be specific to the data above — no generic advice
- Each task is one clear, concrete sentence
- Maximum 3 tasks per section
- Only include a section if there is real data to support it
- Recommendations should reference actual meals or spending patterns observed"""

    try:
        client = anthropic.Anthropic(api_key=os.getenv('ANTHROPIC_API_KEY'))
        msg = client.messages.create(
            model=MODEL, max_tokens=600,
            messages=[{'role': 'user', 'content': prompt}]
        )
        text = msg.content[0].text.strip().replace('```json', '').replace('```', '').strip()
        return jsonify(json.loads(text))
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


def _resolve_recipients() -> list[str]:
    """Return recipient emails from prefs (emails array), falling back to GMAIL_TO env var."""
    try:
        with open(_dpath('prefs.json'), encoding='utf-8') as f:
            p = json.load(f)
        emails = p.get('emails') or []
        if not emails and p.get('email'):
            emails = [p['email']]
    except Exception:
        emails = []
    if not emails:
        env_val = os.getenv('GMAIL_TO', '')
        emails = [e.strip() for e in env_val.split(',') if e.strip()]
    return emails


def _send_email(subject: str, body: str) -> None:
    recipients = _resolve_recipients()
    if not recipients:
        raise ValueError('No email configured — set reminder emails in Preferences or GMAIL_TO in .env')
    from_email = os.getenv('GMAIL_FROM', recipients[0])
    app_pw     = os.getenv('GMAIL_APP_PASSWORD', '')
    if not app_pw:
        raise ValueError('GMAIL_APP_PASSWORD not set in .env')
    msg = MIMEMultipart()
    msg['From']    = from_email
    msg['To']      = ', '.join(recipients)
    msg['Subject'] = subject
    msg.attach(MIMEText(body, 'plain'))
    with smtplib.SMTP_SSL('smtp.gmail.com', 465) as server:
        server.login(from_email, app_pw)
        server.send_message(msg)


@app.route('/email-prep-guide', methods=['POST'])
def email_prep_guide():
    sections = (request.json or {}).get('sections', [])
    if not sections:
        return jsonify({'error': 'no sections provided'}), 400
    lines = ['Sunday Meal Prep Guide', '=' * 30, '']
    for sec in sections:
        lines.append(sec.get('title', ''))
        for t in sec.get('tasks', []):
            lines.append(f'  • {t}')
        lines.append('')
    lines.append('— Grocery Agent')
    try:
        _send_email('Grocery Agent — Sunday Prep Guide', '\n'.join(lines))
        return jsonify({'ok': True})
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


# ── Feedback / order import ───────────────────────────────────────────────────

@app.route('/feedback/order-csv', methods=['POST'])
def parse_order_csv():
    csv_text = (request.json or {}).get('csv', '').strip()
    if not csv_text:
        return jsonify({'error': 'no csv provided'}), 400
    try:
        client = anthropic.Anthropic(api_key=os.getenv('ANTHROPIC_API_KEY'))
        msg = client.messages.create(
            model=MODEL,
            max_tokens=1200,
            messages=[{
                'role': 'user',
                'content': f'''Parse this Walmart order history CSV and extract grocery/food items.
Return ONLY a JSON object, no markdown, no explanation:
{{"pantryItems": [{{"name": "normalized item name", "amount": "numeric quantity", "unit": "lb/oz/count/gallon/etc", "shelfDays": 14}}], "brandSuggestions": ["short brand note worth remembering"]}}

Rules for pantryItems:
- Normalize names: "Great Value 2% Milk 1 gallon" → name:"milk", amount:"1", unit:"gallon"
- Include all food/grocery items ordered
- Skip household supplies, electronics, clothing, etc.
- amount: just the number (or empty string if unknown). unit: the measurement word.
- shelfDays: realistic shelf life in days (e.g. milk=10, eggs=21, bread=7, chicken=2, canned goods=365, crackers=90, frozen=180)

Rules for brandSuggestions:
- Only flag non-generic brands worth remembering for future orders
- Example: if they ordered "Rao's Homemade Marinara" → "Rao's Marinara for pasta sauce"
- Keep to 0-3 suggestions max. Empty array if nothing notable.

CSV content:
{csv_text[:4000]}'''
            }]
        )
        text = msg.content[0].text.strip().replace('```json', '').replace('```', '').strip()
        return jsonify(json.loads(text))
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/feedback/order-pdf', methods=['POST'])
def parse_order_pdf():
    pdf_b64 = (request.json or {}).get('pdf', '').strip()
    if not pdf_b64:
        return jsonify({'error': 'no pdf provided'}), 400
    try:
        client = anthropic.Anthropic(api_key=os.getenv('ANTHROPIC_API_KEY'))
        prompt = '''Parse this Walmart order receipt PDF and extract grocery/food items.
Return ONLY a JSON object, no markdown, no explanation:
{"pantryItems": [{"name": "normalized item name", "amount": "numeric quantity", "unit": "lb/oz/count/gallon/etc", "shelfDays": 14}], "brandSuggestions": ["short brand note worth remembering"]}

Rules for pantryItems:
- Normalize names: "Great Value 2% Milk 1 gallon" → name:"milk", amount:"1", unit:"gallon"
- Include all food/grocery items ordered; skip household supplies, electronics, clothing, etc.
- amount: just the number (or empty string if unknown). unit: the measurement word.
- shelfDays: realistic shelf life in days (milk=10, eggs=21, bread=7, chicken=2, canned goods=365, crackers=90, frozen=180)

Rules for brandSuggestions:
- Only flag non-generic brands worth remembering for future orders
- Keep to 0-3 suggestions max. Empty array if nothing notable.'''
        msg = client.messages.create(
            model=MODEL,
            max_tokens=1200,
            messages=[{
                'role': 'user',
                'content': [
                    {'type': 'document', 'source': {'type': 'base64', 'media_type': 'application/pdf', 'data': pdf_b64}},
                    {'type': 'text', 'text': prompt},
                ],
            }]
        )
        text = msg.content[0].text.strip().replace('```json', '').replace('```', '').strip()
        return jsonify(json.loads(text))
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


# ── Cart ──────────────────────────────────────────────────────────────────────

@app.route('/swap-item', methods=['POST'])
def swap_item():
    query = (request.json or {}).get('query', '').strip()
    if not query:
        return jsonify({'error': 'query required'}), 400
    try:
        product = search_product(query)
        if not product:
            return jsonify({'error': 'no product found'}), 404
        price = float(product.get('salePrice', product.get('msrp', 0)))
        return jsonify({
            'name':   product.get('name', query),
            'price':  f'${price:.2f}',
            'itemId': str(product['itemId']),
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/generate-recipe', methods=['POST'])
def generate_recipe():
    body      = request.json or {}
    meal_name = body.get('meal', '').strip()
    easy_mode = bool(body.get('easyMode', False))
    if not meal_name:
        return jsonify({'error': 'meal name required'}), 400
    try:
        h = {}
        try:
            with open(_dpath('prefs.json'), encoding='utf-8') as f:
                p = json.load(f)
            h = p.get('household', {})
        except (FileNotFoundError, json.JSONDecodeError):
            pass
        servings = int(h.get('adults', 2)) + int(h.get('kids', 0))
        client = anthropic.Anthropic(api_key=os.getenv('ANTHROPIC_API_KEY'))
        if easy_mode:
            content = f'''Give simple prep instructions for the store-bought or frozen version of "{meal_name}" for {servings} people.
This is a ready-made product, not a from-scratch recipe.
Return ONLY a JSON object, no markdown, no explanation:
{{"ingredients": ["quantity + product name (e.g. '1 frozen stuffed crust pizza')", ...], "steps": ["One clear prep step.", ...]}}
Keep ingredients to the actual packaged products plus any simple add-ons (side salad, drinks, etc.). 2-5 ingredients, 3-6 steps.'''
        else:
            content = f'''Generate a complete recipe for "{meal_name}" for {servings} people.
Return ONLY a JSON object, no markdown, no explanation:
{{"ingredients": ["amount + ingredient name", ...], "steps": ["Step description", ...]}}
Use real kitchen measurements for amounts: cups, tbsp, tsp, oz, lbs, cans, cloves, etc. (e.g. "2 cups flour", "1 tbsp olive oil", "1/2 tsp salt", "1.5 lbs chicken breast").
Keep it practical and family-friendly. 6-10 ingredients, 5-8 steps. Each step should be one clear sentence.'''
        msg = client.messages.create(
            model=MODEL,
            max_tokens=800,
            messages=[{'role': 'user', 'content': content}]
        )
        text = msg.content[0].text.strip().replace('```json', '').replace('```', '').strip()
        return jsonify(json.loads(text))
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def _generate_raw_ingredients(meal_name: str, servings: int = 4) -> list:
    client = anthropic.Anthropic(api_key=os.getenv('ANTHROPIC_API_KEY'))
    msg = client.messages.create(
        model=MODEL,
        max_tokens=600,
        messages=[{"role": "user", "content": f"""List the ingredients for {meal_name} for {servings} people.

Return ONLY a JSON array, no markdown:
[{{"name": "ingredient name", "amount": "1.5", "unit": "lb"}}, ...]

Rules:
- Simple ingredient names, no brands
- Realistic quantities for {servings} servings
- Units: lb, oz, cup, count, tbsp, tsp, clove, can, package
- Skip salt, pepper, oil — assumed stocked
- 6-10 ingredients max"""}]
    )
    text = msg.content[0].text.strip().replace("```json", "").replace("```", "").strip()
    return json.loads(text)


def _generate_easy_review_ingredients(meal_name: str, servings: int = 4) -> list:
    client = anthropic.Anthropic(api_key=os.getenv('ANTHROPIC_API_KEY'))
    msg = client.messages.create(
        model=MODEL,
        max_tokens=200,
        messages=[{"role": "user", "content": f"""List only the packaged/ready-made products needed to prepare "{meal_name}" for {servings} people.
This is a store-bought or frozen product, NOT a from-scratch recipe.
Return ONLY a JSON array, no markdown:
[{{"name": "product name", "amount": "1", "unit": "box"}}]
1-3 items max (the main package plus any simple sides). Keep it minimal."""}]
    )
    text = msg.content[0].text.strip().replace("```json", "").replace("```", "").strip()
    return json.loads(text)


@app.route('/generate-ingredients', methods=['POST'])
def generate_ingredients():
    try:
        data      = request.json
        raw_meals = data.get('meals', [])
        servings  = int(data.get('servings', 4))

        if raw_meals and isinstance(raw_meals[0], str):
            meal_items = [{'name': n, 'easyMode': False} for n in raw_meals]
        else:
            meal_items = raw_meals

        recipes_by_name = {r['name'].lower(): r for r in _load_recipes()}
        result  = {}
        sources = {}

        for item in meal_items:
            meal_name = item.get('name', '')
            easy_mode = item.get('easyMode', False)

            if easy_mode:
                result[meal_name]  = _generate_easy_review_ingredients(meal_name, servings)
                sources[meal_name] = 'easy_mode'
            else:
                recipe = recipes_by_name.get(meal_name.lower())
                if recipe and recipe.get('ingredients') and len(recipe['ingredients']) > 0:
                    result[meal_name]  = recipe['ingredients']
                    sources[meal_name] = 'recipe_book'
                else:
                    result[meal_name]  = _generate_raw_ingredients(meal_name, servings)
                    sources[meal_name] = 'generated'

        return jsonify({'ingredients': result, 'sources': sources})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/build-cart', methods=['POST'])
def build_cart():
    try:
        data                  = request.json
        meals                 = data.get('meals', [])
        breakfasts            = data.get('breakfasts', [])
        lunches               = data.get('lunches', [])
        household             = data.get('household', [])
        dessert               = data.get('dessert', '')
        snacks                = data.get('snacks', [])
        holiday               = data.get('holiday') or {}
        zip_code              = data.get('zip', os.getenv('DELIVERY_ZIP', '59047'))
        servings              = int(data.get('servings', 4))
        precomputed_ingreds   = data.get('ingredients', {})

        print(f"\n=== BUILD CART REQUEST ===")
        print(f"Meals: {meals}, Breakfasts: {breakfasts}, Lunches: {lunches}")
        if precomputed_ingreds:
            print(f"Using precomputed ingredients for: {list(precomputed_ingreds.keys())}")

        all_search_tasks = []

        job_sources = (
            [(name, name)          for name in meals] +
            [(name, 'Breakfasts')  for name in breakfasts] +
            [(name, 'Lunches')     for name in lunches]
        )
        if holiday.get('menu'):
            holiday_dishes = []
            for dishes in holiday['menu'].values():
                holiday_dishes.extend(dishes)
            job_sources = job_sources + [(dish, 'holiday') for dish in holiday_dishes if dish]
        elif holiday.get('nights'):
            for night in holiday['nights']:
                if night.get('dinner'):
                    job_sources.append((night['dinner'], 'hosting'))
                for side in (night.get('sides') or []):
                    if side:
                        job_sources.append((side, 'hosting'))
        elif holiday.get('plan'):
            plan = holiday['plan']
            all_items = []
            for day in plan.get('travelDays', []):
                for meal in day.get('meals', []):
                    all_items.extend(meal.get('items', []))
            dest = plan.get('destinationDays', {})
            if not dest.get('eatOut'):
                for meal in dest.get('meals', []):
                    all_items.extend(meal.get('items', []))
            job_sources = job_sources + [(item, 'vacation') for item in all_items if item]
        elif holiday.get('items'):
            job_sources = job_sources + [(item, 'vacation') for item in holiday['items'] if item]
        elif holiday.get('type'):
            holiday_label = f"{holiday['type']} for {holiday.get('guests', 8)} people"
            job_sources = job_sources + [(holiday_label, 'holiday')]

        recipes_by_name = {r['name'].lower(): r for r in _load_recipes()}

        try:
            with open(_dpath('prefs.json'), encoding='utf-8') as _f:
                _p = json.load(_f)
            brand_rules = _p.get('brandRules') or []
        except (FileNotFoundError, json.JSONDecodeError):
            brand_rules = []

        weekly_override  = data.get('weeklyStaples')
        raw_staples      = weekly_override if weekly_override is not None else _load_staples()
        cached_staples   = [s for s in raw_staples if isinstance(s, dict) and s.get('itemId')]
        uncached_staples = [s for s in raw_staples if not (isinstance(s, dict) and s.get('itemId'))]
        print(f"Staples: {len(cached_staples)} cached, {len(uncached_staples)} uncached")

        claude_jobs = {}
        with ThreadPoolExecutor(max_workers=min(len(job_sources) + 1, 14)) as ex:
            for name, source_label in job_sources:
                if name in precomputed_ingreds:
                    ingredients = precomputed_ingreds[name]
                else:
                    recipe      = recipes_by_name.get(name.lower())
                    ingredients = (recipe.get('ingredients') or []) if recipe else []
                claude_jobs[ex.submit(get_search_queries_for_meal, name, servings, ingredients or None, brand_rules)] = source_label
            staple_fut = ex.submit(get_staple_queries, uncached_staples)
            claude_jobs[staple_fut] = 'staples'

            for fut in as_completed(claude_jobs):
                source = claude_jobs[fut]
                try:
                    queries = fut.result()
                    print(f"  [{source}]: {len(queries)} queries")
                    if source == 'staples':
                        uncached_ids = [s.get('id') if isinstance(s, dict) else None for s in uncached_staples]
                        for i, q in enumerate(queries):
                            if i < len(uncached_ids) and uncached_ids[i]:
                                q['_stapleId'] = uncached_ids[i]
                    for q in queries:
                        all_search_tasks.append({**q, 'source': source})
                except Exception as e:
                    print(f"  ERROR getting queries for {source}: {e}")
                    traceback.print_exc()

        for name in household:
            all_search_tasks.append({"search_query": name, "qty": 1, "source": "household"})
        if dessert:
            all_search_tasks.append({"search_query": dessert, "qty": 1, "source": "dessert"})
        for name in snacks:
            all_search_tasks.append({"search_query": name, "qty": 1, "source": "Snacks"})
        for name in data.get('trainingItems', []):
            all_search_tasks.append({"search_query": name, "qty": 1, "source": "training"})

        _seen_q = {}
        deduped = []
        for task in all_search_tasks:
            key = task['search_query'].lower().strip()
            if key not in _seen_q:
                _seen_q[key] = True
                deduped.append(task)
        all_search_tasks = deduped

        print(f"\nTotal search tasks: {len(all_search_tasks)} (after dedup)")

        search_results = []
        with ThreadPoolExecutor(max_workers=max(1, min(len(all_search_tasks), 10))) as ex:
            fut_to_task = {ex.submit(search_product, t['search_query']): t for t in all_search_tasks}
            for fut in as_completed(fut_to_task):
                task = fut_to_task[fut]
                try:
                    product = fut.result()
                    search_results.append((task, product))
                except Exception as e:
                    print(f"  - Search error for '{task['search_query']}': {e}")

        cart_items       = []
        groups           = {}
        seen_ids         = set()
        not_found        = []
        total            = 0.0
        resolved_staples = []

        for s in cached_staples:
            item_id = str(s['itemId'])
            qty     = int(s.get('qty', 1))
            if item_id not in seen_ids:
                seen_ids.add(item_id)
                price = float(s.get('lastPrice') or 0)
                cart_items.append({"itemId": item_id, "quantity": qty})
                groups.setdefault('staples', []).append({
                    "name":  s.get('productName') or s.get('name', 'Unknown'),
                    "price": f"${price:.2f}" if price else "$?",
                    "itemId": item_id,
                    "qty":   qty,
                })
                total += price
                print(f"  + [staples/cached] {s.get('name', item_id)}")

        for task, product in search_results:
            if product:
                item_id = str(product['itemId'])
                if item_id not in seen_ids:
                    seen_ids.add(item_id)
                    price = float(product.get('salePrice', product.get('msrp', 0)))
                    cart_items.append({"itemId": item_id, "quantity": task.get('qty', 1)})
                    source = task.get('source', 'other')
                    groups.setdefault(source, []).append({
                        "name":   product.get("name", "Unknown"),
                        "price":  f"${price:.2f}",
                        "itemId": item_id,
                        "qty":    task.get("qty", 1),
                    })
                    total += price
                    print(f"  + [{source}] {product['name']} ${price}")
                    if source == 'staples' and task.get('_stapleId'):
                        resolved_staples.append({
                            'stapleId':    task['_stapleId'],
                            'itemId':      item_id,
                            'productName': product.get('name', task['search_query']),
                            'lastPrice':   price,
                        })
            else:
                not_found.append(task['search_query'])
                print(f"  - No result: {task['search_query']}")

        meal_order = list(meals) + ['Breakfasts', 'Lunches', 'holiday', 'hosting', 'vacation', 'dessert', 'Snacks', 'training', 'staples', 'household']
        cart_url = build_cart_url(cart_items, staple_items=[])

        print(f"\nCart URL: {cart_url}")
        print(f"Total: ${total:.2f} across {sum(len(v) for v in groups.values())} items")
        if resolved_staples:
            print(f"Resolved {len(resolved_staples)} new staple item IDs for caching")

        return jsonify({
            "groups":          groups,
            "mealOrder":       meal_order,
            "total":           f"${total:.2f}",
            "cartUrl":         cart_url,
            "notFound":        not_found,
            "resolvedStaples": resolved_staples,
        })

    except Exception as e:
        print(f"\n=== CART BUILD ERROR ===")
        traceback.print_exc()
        return jsonify({"error": str(e), "trace": traceback.format_exc()}), 500


# ── Google Calendar ────────────────────────────────────────────────────────────

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
    state    = session.pop('oauth_state', None)
    flow     = _make_google_flow(state=state)
    verifier = session.pop('code_verifier', None)
    kwargs   = {'authorization_response': request.url}
    if verifier:
        kwargs['code_verifier'] = verifier
    try:
        flow.fetch_token(**kwargs)
    except Exception as e:
        return f'Authorization failed: {e}. Try connecting again.', 400
    _save_google_creds(flow.credentials)
    return '''<!DOCTYPE html><html><body>
<script>
  if (window.opener) {
    window.opener.postMessage("calendar_connected", "*");
    window.close();
  } else {
    window.location.href = "/";
  }
</script>
<p>Connected! You can close this window.</p>
</body></html>'''


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

    try:
        with open(_dpath('prefs.json')) as f:
            _prefs = json.load(f)
        tz_name = _prefs.get('timezone') or 'America/Denver'
    except Exception:
        tz_name = 'America/Denver'
    try:
        tz = ZoneInfo(tz_name)
    except Exception:
        tz = ZoneInfo('America/Denver')

    week_param = request.args.get('week', 'current')
    today  = datetime.now(tz)
    monday = today - timedelta(days=today.weekday())
    if week_param == 'next':
        monday += timedelta(weeks=1)
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
    token_path = _dpath('google_token.json')
    if os.path.exists(token_path):
        os.remove(token_path)
    return jsonify({'ok': True})


def _make_google_flow(state=None):
    redirect_uri = f'{_APP_BASE_URL}/calendar/callback'
    return Flow.from_client_config(
        {'web': {
            'client_id':     os.getenv('GOOGLE_CLIENT_ID'),
            'client_secret': os.getenv('GOOGLE_CLIENT_SECRET'),
            'auth_uri':      'https://accounts.google.com/o/oauth2/auth',
            'token_uri':     'https://oauth2.googleapis.com/token',
            'redirect_uris': [redirect_uri],
        }},
        scopes=GOOGLE_SCOPES,
        redirect_uri=redirect_uri,
        state=state
    )


def _load_google_creds():
    token_path = _dpath('google_token.json')
    if not os.path.exists(token_path):
        return None
    try:
        with open(token_path) as f:
            return Credentials.from_authorized_user_info(json.load(f), GOOGLE_SCOPES)
    except Exception:
        return None


def _save_google_creds(creds):
    os.makedirs(_data_dir(), exist_ok=True)
    with open(_dpath('google_token.json'), 'w') as f:
        f.write(creds.to_json())


# ── Data helpers ───────────────────────────────────────────────────────────────

def _load_pantry() -> list:
    try:
        with open(_dpath('pantry.json'), encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _save_pantry(pantry: list) -> None:
    os.makedirs(_data_dir(), exist_ok=True)
    with open(_dpath('pantry.json'), 'w', encoding='utf-8') as f:
        json.dump(pantry, f, indent=2)


def _load_pantry_feedback() -> list:
    try:
        with open(_dpath('pantry_idea_feedback.json'), encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _save_pantry_feedback(feedback: list) -> None:
    os.makedirs(_data_dir(), exist_ok=True)
    with open(_dpath('pantry_idea_feedback.json'), 'w', encoding='utf-8') as f:
        json.dump(feedback, f, indent=2)


def _load_recipes() -> list:
    try:
        with open(_dpath('recipes.json'), encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _save_recipes(recipes: list) -> None:
    os.makedirs(_data_dir(), exist_ok=True)
    with open(_dpath('recipes.json'), 'w', encoding='utf-8') as f:
        json.dump(recipes, f, indent=2)


def _load_staples() -> list:
    try:
        with open(_dpath('staples.json'), encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _save_staples(staples: list) -> None:
    os.makedirs(_data_dir(), exist_ok=True)
    with open(_dpath('staples.json'), 'w', encoding='utf-8') as f:
        json.dump(staples, f, indent=2)


# ── Walmart search helpers ─────────────────────────────────────────────────────

_FOOD_BRAND_ITEMS = {
    'chicken', 'pasta sauce', 'parmesan', 'bread', 'sandwich rolls', 'bbq sauce',
    'butter', 'coffee', 'milk',
}

def _brand_rules_snippet(brand_rules: list) -> str:
    if not brand_rules:
        return ''
    food_rules = [r for r in brand_rules if any(kw in r.get('item', '').lower() for kw in _FOOD_BRAND_ITEMS)]
    if not food_rules:
        return ''
    lines = [f"- {r['item']}: {r['brand']}" for r in food_rules[:5]]
    return '\nBrand preferences (prefer these when relevant):\n' + '\n'.join(lines)


def get_search_queries_for_meal(meal_name: str, servings: int = 4, recipe_ingredients: list = None, brand_rules: list = None) -> list[dict]:
    api_key = os.getenv('ANTHROPIC_API_KEY')
    if not api_key:
        raise ValueError("ANTHROPIC_API_KEY not set")

    brand_section = _brand_rules_snippet(brand_rules or [])

    if recipe_ingredients:
        lines = []
        for ing in recipe_ingredients:
            if isinstance(ing, dict):
                name   = ing.get('name', '').strip()
                amount = ing.get('amount', '').strip()
                unit   = ing.get('unit', '').strip()
                parts  = [name]
                if amount:
                    parts.append(f'({amount}{" " + unit if unit else ""})')
                lines.append('- ' + ' '.join(parts))
            elif isinstance(ing, str) and ing.strip():
                lines.append('- ' + ing.strip())
        ingredient_list = '\n'.join(lines)
        prompt = f"""Convert these recipe ingredients for {meal_name} (serves {servings}) into Walmart search queries.

Ingredients:
{ingredient_list}

Return ONLY a JSON array, no markdown:
[{{"search_query": "descriptive Walmart search string", "qty": 1}}, ...]

Rules:
- One entry per distinct ingredient — use the ingredient list above as the source of truth
- Convert to good Walmart search terms (e.g. "heavy whipping cream" not "cream")
- Keep Rao's Marinara and Prego by brand name — they search well
- qty = 1 unless the recipe clearly needs 2+ packages of the same item
- Skip salt, pepper, olive oil, water — pantry staples assumed stocked{brand_section}"""
    else:
        prompt = f"""Generate Walmart grocery search queries for cooking {meal_name} for {servings} people.

Return ONLY a JSON array, no markdown:
[{{"search_query": "descriptive product search string", "qty": 1}}, ...]

Rules:
- Use descriptive product terms, not brand names (e.g. "boneless skinless chicken thighs" not "Perdue chicken")
- Exception: Rao's Marinara and Prego pasta sauce — include brand name, those search well
- qty is number of packages to add to cart (almost always 1)
- Skip salt, pepper, olive oil — assume those are stocked
- 6-10 ingredients max{brand_section}"""

    client = anthropic.Anthropic(api_key=api_key)
    msg = client.messages.create(
        model=MODEL,
        max_tokens=600,
        messages=[{"role": "user", "content": prompt}]
    )
    text = msg.content[0].text.strip().replace("```json", "").replace("```", "").strip()
    return json.loads(text)


def get_staple_queries(override: list = None) -> list[dict]:
    if override is not None:
        raw_staples = override
    else:
        raw_staples = _load_staples()

    if not raw_staples:
        return []

    def _staple_label(s) -> str:
        if isinstance(s, str):
            return s
        parts = []
        qty  = str(s.get('qty', '') or '').strip()
        unit = (s.get('unit') or '').strip()
        name = (s.get('name') or '').strip()
        if qty and qty != '1':
            parts.append(qty)
        if unit:
            parts.append(unit)
        parts.append(name)
        return ' '.join(parts).strip()

    labels    = [_staple_label(s) for s in raw_staples if _staple_label(s)]
    cache_key = ','.join(sorted(labels))
    if cache_key in _staple_query_cache:
        return _staple_query_cache[cache_key]

    staples_text = '\n'.join(f'- {l}' for l in labels)
    client = anthropic.Anthropic(api_key=os.getenv('ANTHROPIC_API_KEY'))
    msg = client.messages.create(
        model=MODEL,
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
    result = json.loads(text)
    _staple_query_cache[cache_key] = result
    return result


# ── Startup helpers ────────────────────────────────────────────────────────────

def _get_local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return '127.0.0.1'


def _print_startup(local_ip: str) -> None:
    url = f"http://{local_ip}:5000"
    width = 52
    print("=" * width)
    print(f"  Grocery Agent is running")
    print(f"  Desktop : http://localhost:5000")
    print(f"  Phone   : {url}")
    print("=" * width)
    try:
        import qrcode, sys, io
        qr = qrcode.QRCode(border=1)
        qr.add_data(url)
        qr.make(fit=True)
        buf = io.StringIO()
        qr.print_ascii(out=buf, invert=True)
        try:
            print(buf.getvalue())
        except UnicodeEncodeError:
            sys.stdout.buffer.write(buf.getvalue().encode('utf-8'))
            sys.stdout.buffer.flush()
    except ImportError:
        print("  (install qrcode for a scannable QR code: pip install qrcode)")
    print("=" * width)


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--demo', action='store_true', help='Run in demo mode on port 5001 with isolated data/demo/ directory')
    parser.add_argument('--seed', action='store_true', help='(with --demo) Copy live user data into data/demo/ before starting')
    args = parser.parse_args()

    port = 5000
    if args.demo:
        _DEMO_MODE = True
        demo_dir = os.path.join(_DATA_ROOT, 'demo')
        os.makedirs(demo_dir, exist_ok=True)
        _DATA_DIR_OVERRIDE = demo_dir
        _APP_BASE_URL = 'http://localhost:5001'
        port = 5001

        if args.seed:
            users = _load_users()
            live_users = users.get('users', {})
            if live_users:
                first_user = next(iter(live_users))
                live_dir = os.path.join(_DATA_ROOT, 'users', first_user)
                if os.path.isdir(live_dir):
                    for fname in os.listdir(live_dir):
                        src = os.path.join(live_dir, fname)
                        if os.path.isfile(src):
                            shutil.copy2(src, os.path.join(demo_dir, fname))
                    print(f"  ✓  Demo seeded from live data ({first_user})")
                else:
                    print("  ⚠  No live user data directory found to seed from")
            else:
                print("  ⚠  No users found — demo will start empty")

    if app.secret_key == 'grocery-agent-local-dev-secret':
        print("  ⚠  FLASK_SECRET_KEY not set — sessions are insecure (OK for local use only)")
    users = _load_users()
    if not users['users'] and not args.demo:
        print(f"  → No accounts yet. Visit http://localhost:{port}/login to create yours.")
    local_ip = _get_local_ip()
    _print_startup(local_ip)
    app.run(host='0.0.0.0', port=port, debug=False)
