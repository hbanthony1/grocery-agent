"""
test_server.py — Demo version of the Grocery Agent.

Runs on port 5001 (leave your real server on 5000).
No API keys needed. No .env required. Nothing is written to disk.
All changes (recipes, pantry, prefs) live in memory and reset on restart.

Start: python test_server.py
Open:  http://localhost:5001
"""

import copy, json, time
from flask import Flask, jsonify, request, send_from_directory, Response
from flask_cors import CORS
import os

app = Flask(__name__, static_folder='static')
CORS(app, origins='*')

# ---------------------------------------------------------------------------
# DUMMY DATA
# ---------------------------------------------------------------------------

_DEMO_PREFS = {
    "household": {
        "adults": 2,
        "kids": 2,
        "kidsAges": "ages 8 and 5",
        "zip": "10001",
        "budgetTarget": 150,
        "budgetMax": 200
    },
    "dietaryNotes": [
        "No shellfish",
        "One vegetarian meal per week preferred",
        "Kids prefer mild, familiar flavors",
        "Trying to limit red meat to 2x per week"
    ],
    "weeklyStaples": [
        "Milk (1 gallon, whole)",
        "Eggs (1 dozen)",
        "Sandwich bread (white or wheat)",
        "Bananas",
        "Apples",
        "Baby carrots"
    ],
    "frequentStaples": [
        "Greek yogurt",
        "Orange juice",
        "Shredded cheddar cheese",
        "Butter"
    ],
    "brandRules": [
        {"item": "cheese",     "brand": "Tillamook"},
        {"item": "pasta sauce","brand": "Rao's Marinara"},
        {"item": "hot dogs",   "brand": "Nathan's Famous"}
    ],
    "storeOk": "pasta, canned goods, frozen vegetables, flour, sugar, rice",
    "doNotRepeat": [],
    "notes": "Family of 4 with two school-age kids. Weeknight meals should be under 45 minutes.",
    "householdItems": [
        "Paper towels",
        "Dish soap",
        "Laundry detergent",
        "Trash bags (kitchen size)",
        "Shampoo",
        "Kids' toothpaste",
        "Hand soap refill"
    ]
}

_DEMO_RECIPES = [
    {"id": "r01", "name": "Pasta with Meat Sauce",         "rating": 5, "tags": ["kid-friendly", "comfort-food"], "notes": "Rao's Marinara + 80/20 ground beef",               "timesPlanned": 9,  "lastPlanned": "2026-04-28"},
    {"id": "r02", "name": "Chicken Pot Pie",               "rating": 5, "tags": ["kid-friendly", "comfort-food"], "notes": "Frozen pie shells + rotisserie chicken",            "timesPlanned": 7,  "lastPlanned": "2026-04-14"},
    {"id": "r03", "name": "Tacos",                         "rating": 5, "tags": ["quick", "kid-friendly"],        "notes": "Ground beef + taco seasoning + ROTEL",              "timesPlanned": 11, "lastPlanned": "2026-05-05"},
    {"id": "r04", "name": "Stuffed Crust Pizza",           "rating": 4, "tags": ["quick", "kid-friendly"],        "notes": "Great Value frozen 3-meat — reliable Friday night", "timesPlanned": 8,  "lastPlanned": "2026-04-25"},
    {"id": "r05", "name": "Meatball Subs",                 "rating": 4, "tags": ["kid-friendly"],                 "notes": "Frozen meatballs + hoagie rolls + mozzarella",      "timesPlanned": 5,  "lastPlanned": "2026-04-07"},
    {"id": "r06", "name": "Chicken Stir Fry",              "rating": 4, "tags": ["quick"],                        "notes": "Chicken thighs + frozen stir fry veg + soy sauce", "timesPlanned": 4,  "lastPlanned": "2026-03-24"},
    {"id": "r07", "name": "Butter Chicken with Naan",      "rating": 4, "tags": ["quick"],                        "notes": "Frozen butter chicken + Stonefire mini naan",       "timesPlanned": 3,  "lastPlanned": "2026-03-10"},
    {"id": "r08", "name": "Slow Cooker Beef Stew",         "rating": 4, "tags": ["weekend", "comfort-food"],      "notes": "Chuck roast + potatoes + carrots — all day",       "timesPlanned": 3,  "lastPlanned": "2026-02-16"},
    {"id": "r09", "name": "Lasagna",                       "rating": 5, "tags": ["weekend", "comfort-food"],      "notes": "Big batch Sunday cook — feeds family 2 nights",    "timesPlanned": 4,  "lastPlanned": "2026-01-19"},
    {"id": "r10", "name": "Grilled Cheese and Tomato Soup","rating": 3, "tags": ["quick", "kid-friendly"],        "notes": "Panera tomato soup + sourdough",                    "timesPlanned": 3,  "lastPlanned": "2026-02-03"},
    {"id": "r11", "name": "Sheet Pan Chicken and Veggies", "rating": 4, "tags": ["quick"],                        "notes": "Chicken thighs + broccoli + potatoes at 425°F",    "timesPlanned": 2,  "lastPlanned": "2026-01-27"},
    {"id": "r12", "name": "Chili",                         "rating": 4, "tags": ["comfort-food"],                 "notes": "ROTEL + kidney beans + ground beef + corn bread",  "timesPlanned": 3,  "lastPlanned": "2025-12-09"},
]

_DEMO_PANTRY = [
    {"id": "p01", "name": "Pasta (spaghetti)",   "amount": "2",  "unit": "boxes",   "expiresOn": "",           "addedOn": "2026-04-01"},
    {"id": "p02", "name": "Rao's Marinara",       "amount": "1",  "unit": "jar",     "expiresOn": "",           "addedOn": "2026-04-01"},
    {"id": "p03", "name": "Canned diced tomatoes","amount": "3",  "unit": "cans",    "expiresOn": "",           "addedOn": "2026-03-15"},
    {"id": "p04", "name": "Chicken broth",        "amount": "1",  "unit": "carton",  "expiresOn": "2026-05-28", "addedOn": "2026-04-10"},
    {"id": "p05", "name": "Heavy cream",          "amount": "1",  "unit": "pint",    "expiresOn": "2026-05-22", "addedOn": "2026-05-13"},
    {"id": "p06", "name": "Taco seasoning",       "amount": "2",  "unit": "packets", "expiresOn": "",           "addedOn": "2026-03-01"},
    {"id": "p07", "name": "Rice (long grain)",    "amount": "1",  "unit": "bag",     "expiresOn": "",           "addedOn": "2026-02-20"},
    {"id": "p08", "name": "Olive oil",            "amount": "1",  "unit": "bottle",  "expiresOn": "",           "addedOn": "2026-01-15"},
    {"id": "p09", "name": "Frozen broccoli",      "amount": "1",  "unit": "bag",     "expiresOn": "2026-08-01", "addedOn": "2026-05-10"},
    {"id": "p10", "name": "Spinach (fresh bag)",  "amount": "1",  "unit": "bag",     "expiresOn": "2026-05-21", "addedOn": "2026-05-17"},
]

_DEMO_CART = {
    "items": [
        # Pasta with Meat Sauce
        {"name": "Barilla Spaghetti 16 oz",                  "price": "$1.48"},
        {"name": "Rao's Homemade Marinara Sauce 24 oz",       "price": "$8.97"},
        {"name": "80/20 Ground Beef 1 lb",                    "price": "$5.48"},
        {"name": "Parmesan Cheese Shredded 5 oz",             "price": "$3.27"},
        # Meatball Subs
        {"name": "Cooked Frozen Meatballs 26 oz",             "price": "$6.98"},
        {"name": "Hoagie Rolls 6-pack",                       "price": "$2.98"},
        {"name": "Great Value Mozzarella Shredded 8 oz",      "price": "$2.78"},
        # Chicken Pot Pie
        {"name": "Rotisserie Chicken (whole)",                 "price": "$6.97"},
        {"name": "Frozen Pie Shells 2-pack",                  "price": "$3.48"},
        {"name": "Frozen Mixed Vegetables 12 oz",             "price": "$1.28"},
        {"name": "Cream of Chicken Soup 10.5 oz",             "price": "$1.18"},
        # Chicken Stir Fry
        {"name": "Boneless Skinless Chicken Thighs 2 lb",     "price": "$7.28"},
        {"name": "Frozen Stir Fry Vegetables 14 oz",          "price": "$2.48"},
        {"name": "Soy Sauce 10 oz",                           "price": "$2.12"},
        {"name": "Minute Rice White 14 oz",                   "price": "$2.98"},
        # Weekly staples
        {"name": "Great Value Whole Milk 1 Gallon",           "price": "$3.84"},
        {"name": "Great Value Large Eggs 12 ct",              "price": "$2.96"},
        {"name": "Wonder Classic White Bread 20 oz",          "price": "$2.68"},
        {"name": "Fresh Bananas (bunch)",                     "price": "$1.22"},
        {"name": "Gala Apples 3 lb bag",                      "price": "$4.48"},
        {"name": "Grimmway Baby Carrots 1 lb",                "price": "$1.48"},
        # Household
        {"name": "Bounty Select-A-Size Paper Towels 6-pack",  "price": "$9.97"},
        {"name": "Dawn Dish Soap Original 19 oz",             "price": "$3.47"},
    ],
    "total": "$89.83",
    "cartUrl": "https://www.walmart.com/cart"
}

# ---------------------------------------------------------------------------
# IN-MEMORY STATE (resets on restart — nothing touches disk)
# ---------------------------------------------------------------------------

_prefs   = copy.deepcopy(_DEMO_PREFS)
_recipes = copy.deepcopy(_DEMO_RECIPES)
_pantry  = copy.deepcopy(_DEMO_PANTRY)

# ---------------------------------------------------------------------------
# DEMO BANNER (injected into index.html)
# ---------------------------------------------------------------------------

BANNER = (
    '<div style="background:#c48a1a;color:#fff;text-align:center;'
    'padding:9px 16px;font-family:Georgia,serif;font-size:13px;'
    'letter-spacing:0.04em;font-style:italic;">'
    'demo mode &mdash; generic dummy data &mdash; nothing is saved'
    '</div>'
)

# ---------------------------------------------------------------------------
# ROUTES
# ---------------------------------------------------------------------------

@app.route('/')
def index():
    path = os.path.join(os.path.dirname(__file__), 'static', 'index.html')
    html = open(path, encoding='utf-8').read()
    html = html.replace('<body>', f'<body>\n{BANNER}', 1)
    return Response(html, mimetype='text/html')


@app.route('/static/<path:path>')
def static_files(path):
    return send_from_directory('static', path)


@app.route('/ping')
def ping():
    return jsonify({'ok': True})


# --- Prefs ---

@app.route('/prefs', methods=['GET'])
def get_prefs():
    return jsonify(_prefs)


@app.route('/prefs', methods=['POST'])
def save_prefs():
    global _prefs
    _prefs = request.json or {}
    return jsonify({'ok': True})


@app.route('/household-items', methods=['GET'])
def household_items():
    return jsonify({'items': _prefs.get('householdItems', [])})


# --- Recipes ---

@app.route('/recipes', methods=['GET'])
def get_recipes():
    return jsonify(_recipes)


@app.route('/recipes', methods=['POST'])
def add_recipe():
    body = request.json or {}
    name = (body.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'name required'}), 400
    for r in _recipes:
        if r['name'].lower() == name.lower():
            r['timesPlanned'] = r.get('timesPlanned', 0) + body.get('timesPlanned', 1)
            r['lastPlanned']  = body.get('lastPlanned', r.get('lastPlanned', ''))
            if body.get('rating'):
                r['rating'] = body['rating']
            if body.get('notes'):
                r['notes'] = body['notes']
            return jsonify(r), 200
    recipe = {
        'id':          f"demo-{int(time.time()*1000)}",
        'name':        name,
        'rating':      body.get('rating', 0),
        'tags':        body.get('tags', []),
        'notes':       body.get('notes', ''),
        'timesPlanned':body.get('timesPlanned', 1),
        'lastPlanned': body.get('lastPlanned', ''),
    }
    _recipes.append(recipe)
    return jsonify(recipe), 201


@app.route('/recipes/<recipe_id>', methods=['PATCH'])
def update_recipe(recipe_id):
    for r in _recipes:
        if r['id'] == recipe_id:
            r.update({k: v for k, v in (request.json or {}).items() if k != 'id'})
            return jsonify(r)
    return jsonify({'error': 'not found'}), 404


@app.route('/recipes/<recipe_id>', methods=['DELETE'])
def delete_recipe(recipe_id):
    global _recipes
    _recipes = [r for r in _recipes if r['id'] != recipe_id]
    return jsonify({'ok': True})


# --- Pantry ---

@app.route('/pantry', methods=['GET'])
def get_pantry():
    return jsonify(_pantry)


@app.route('/pantry', methods=['POST'])
def add_pantry():
    body = request.json or {}
    name = (body.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'name required'}), 400
    item = {
        'id':        f"demo-{int(time.time()*1000)}",
        'name':      name,
        'amount':    body.get('amount', ''),
        'unit':      body.get('unit', ''),
        'expiresOn': body.get('expiresOn', ''),
        'addedOn':   body.get('addedOn', ''),
    }
    _pantry.append(item)
    return jsonify(item), 201


@app.route('/pantry/<item_id>', methods=['PATCH'])
def update_pantry(item_id):
    for i in _pantry:
        if i['id'] == item_id:
            i.update({k: v for k, v in (request.json or {}).items() if k != 'id'})
            return jsonify(i)
    return jsonify({'error': 'not found'}), 404


@app.route('/pantry/<item_id>', methods=['DELETE'])
def delete_pantry(item_id):
    global _pantry
    _pantry = [i for i in _pantry if i['id'] != item_id]
    return jsonify({'ok': True})


# --- Generate recipe ---

@app.route('/generate-recipe', methods=['POST'])
def generate_recipe():
    time.sleep(1)
    return jsonify({
        'ingredients': [
            '1.5 lbs boneless skinless chicken breast',
            '2 cups long grain white rice',
            '1 can (14 oz) chicken broth',
            '1 medium onion, diced',
            '3 cloves garlic, minced',
            '2 tablespoons olive oil',
            '1 teaspoon paprika',
            'Salt and pepper to taste',
        ],
        'steps': [
            'Season chicken generously with salt, pepper, and paprika.',
            'Heat olive oil in a large skillet over medium-high heat until shimmering.',
            'Add chicken and cook 6–7 minutes per side until golden brown and cooked through. Remove and set aside.',
            'In the same pan, sauté onion until softened, about 3 minutes. Add garlic and cook 1 more minute.',
            'Add rice and stir to coat in the pan drippings. Pour in chicken broth and 1½ cups water. Bring to a boil.',
            'Reduce heat to low, cover tightly, and simmer 18 minutes until rice is tender and liquid is absorbed.',
            'Slice chicken and serve over rice.',
        ]
    })


# --- Cart ---

@app.route('/build-cart', methods=['POST'])
def build_cart():
    # Simulate the ~2 second processing time
    time.sleep(2)
    return jsonify(_DEMO_CART)


# ---------------------------------------------------------------------------

if __name__ == '__main__':
    print("=" * 55)
    print("  GROCERY AGENT — DEMO SERVER")
    print("  http://localhost:5001")
    print()
    print("  Dummy data only. No API keys. Nothing saved to disk.")
    print("  Your real server on port 5000 is unaffected.")
    print("=" * 55)
    app.run(port=5001, debug=False)
