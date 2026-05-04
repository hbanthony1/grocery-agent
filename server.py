from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from walmart_tool import search_product, build_cart_url
import anthropic, os, json, re, time, traceback
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
CORS(app, origins="*")

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


@app.route('/recipes/<recipe_id>', methods=['DELETE'])
def delete_recipe(recipe_id):
    _save_recipes([r for r in _load_recipes() if r['id'] != recipe_id])
    return jsonify({'ok': True})


@app.route('/build-cart', methods=['POST'])
def build_cart():
    try:
        data      = request.json
        meals     = data.get('meals', [])
        household = data.get('household', [])
        zip_code  = data.get('zip', os.getenv('DELIVERY_ZIP', '59047'))

        print(f"\n=== BUILD CART REQUEST ===")
        print(f"Meals: {meals}")

        cart_items   = []  # [{"itemId": str, "quantity": int}]
        all_products = []
        seen_ids     = set()

        for meal_name in meals:
            print(f"\nProcessing: {meal_name}")
            try:
                queries = get_search_queries_for_meal(meal_name)
                print(f"  Queries: {len(queries)}")

                for q in queries:
                    try:
                        product = search_product(q['search_query'])
                        if product:
                            item_id = str(product['itemId'])
                            if item_id not in seen_ids:
                                seen_ids.add(item_id)
                                cart_items.append({"itemId": item_id, "quantity": q.get('qty', 1)})
                                all_products.append(product)
                                print(f"    ✓ {product['name']} ${product.get('salePrice', product.get('msrp', 0))}")
                        else:
                            print(f"    - No result: {q['search_query']}")
                    except Exception as e:
                        print(f"    - Search error for '{q['search_query']}': {e}")
                        continue

            except Exception as meal_err:
                print(f"  ERROR for {meal_name}: {meal_err}")
                traceback.print_exc()
                continue

        # Add weekly staples from preferences.md
        print("\nProcessing staples...")
        try:
            for q in get_staple_queries():
                try:
                    product = search_product(q['search_query'])
                    if product:
                        item_id = str(product['itemId'])
                        if item_id not in seen_ids:
                            seen_ids.add(item_id)
                            cart_items.append({"itemId": item_id, "quantity": q.get('qty', 1)})
                            all_products.append(product)
                            print(f"  ✓ {product['name']} ${product.get('salePrice', product.get('msrp', 0))}")
                    else:
                        print(f"  - No result: {q['search_query']}")
                except Exception as e:
                    print(f"  - Search error for '{q['search_query']}': {e}")
        except Exception as e:
            print(f"  ERROR loading staples: {e}")
            traceback.print_exc()

        # Add household / non-grocery items selected by user
        if household:
            print("\nProcessing household items...")
            for item_name in household:
                try:
                    product = search_product(item_name)
                    if product:
                        item_id = str(product['itemId'])
                        if item_id not in seen_ids:
                            seen_ids.add(item_id)
                            cart_items.append({"itemId": item_id, "quantity": 1})
                            all_products.append(product)
                            print(f"  ✓ {product['name']} ${product.get('salePrice', product.get('msrp', 0))}")
                    else:
                        print(f"  - No result: {item_name}")
                except Exception as e:
                    print(f"  - Search error for '{item_name}': {e}")

        cart_url = build_cart_url(cart_items, staple_items=[])
        total    = sum(float(p.get('salePrice', p.get('msrp', 0))) for p in all_products)

        print(f"\nCart URL: {cart_url}")
        print(f"Total: ${total:.2f} across {len(all_products)} items")

        return jsonify({
            "items":   [{"name": p.get("name", "Unknown"), "price": f"${float(p.get('salePrice', p.get('msrp', 0))):.2f}"} for p in all_products],
            "total":   f"${total:.2f}",
            "cartUrl": cart_url
        })

    except Exception as e:
        print(f"\n=== CART BUILD ERROR ===")
        traceback.print_exc()
        return jsonify({"error": str(e), "trace": traceback.format_exc()}), 500


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
    app.run(port=5000, debug=True)
