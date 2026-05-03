from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from walmart_tool import search_product, build_cart_url
import anthropic, os, json, re, traceback
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
CORS(app, origins="*")


@app.route('/')
def index():
    return send_from_directory('static', 'index.html')


@app.route('/ping')
def ping():
    return jsonify({"ok": True})


@app.route('/household-items', methods=['GET'])
def get_household_items():
    return jsonify({"items": _parse_household_items()})


@app.route('/preferences', methods=['GET'])
def get_preferences():
    prefs_path = os.path.join(os.path.dirname(__file__), 'preferences.md')
    try:
        content = open(prefs_path, encoding='utf-8').read()
        return jsonify({"content": content})
    except FileNotFoundError:
        return jsonify({"content": ""})


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
    """Read preferences.md and extract weekly staples as Walmart search queries."""
    prefs_path = os.path.join(os.path.dirname(__file__), 'preferences.md')
    prefs = open(prefs_path, encoding='utf-8').read()

    client = anthropic.Anthropic(api_key=os.getenv('ANTHROPIC_API_KEY'))
    msg = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=400,
        messages=[{
            "role": "user",
            "content": f"""From the preferences below, extract ONLY the items listed under "Weekly staples — order every single week" as Walmart search queries.

PREFERENCES:
{prefs}

Return ONLY a JSON array, no markdown:
[{{"search_query": "descriptive product search string", "qty": 1}}, ...]

Use descriptive terms that work on Walmart search (e.g. "organic bananas bunch" not "Marketside Fresh Organic Bananas")."""
        }]
    )
    text = msg.content[0].text.strip().replace("```json", "").replace("```", "").strip()
    return json.loads(text)


if __name__ == '__main__':
    print("=" * 50)
    print("Grocery agent server running at http://localhost:5000")
    print("Health check: http://localhost:5000/ping")
    print("Open index.html in Chrome to start planning.")
    print("=" * 50)
    app.run(port=5000, debug=True)
