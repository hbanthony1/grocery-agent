# Grocery Agent — Project Context

Personal weekly grocery planner for Hannah's household in Livingston, MT 59047.
GitHub: https://github.com/hbanthony1/grocery-agent

## What it does

Browser app (served by local Flask server) that handles the full Sunday planning flow:
1. **Your Week** — set per-day schedule complexity, pick breakfasts/lunch/snacks/dessert, review last week's recap, connect Google Calendar
2. **Meal Plan** — Claude generates dinners matched to schedule; swap individual meals from recipe book
3. **Household** — checklist of non-food and extra items to add to cart
4. **Cart** — Walmart product search builds a pre-filled cart URL; open and check out

Post-order: upload Walmart CSV/PDF receipt → auto-update pantry + flag brand preferences.
Meal ratings feed back into future plan generation.

## How to run

```
cd C:\Users\hbant\Documents\grocery_agent
python server.py
# open http://localhost:5000
```

Demo mode (no API keys needed):
```
python test_server.py
# open http://localhost:5001
```

Run tests:
```
.\run_tests.ps1           # both suites
.\run_tests.ps1 -backend  # pytest only (43 tests)
.\run_tests.ps1 -js       # node only (27 tests)
```

## Stack

- **Frontend:** Vanilla JS SPA (~3100 lines app.js), no framework, served from Flask
- **Backend:** Python Flask (port 5000), proxies Walmart + Google Calendar API calls
- **AI:** Anthropic API (`claude-sonnet-4-6`) — meal plan, ingredient queries, feedback parsing, recipe backfill
- **Walmart:** Product Search API (`/affil/product/v2/search`) with RSA-SHA256 auth
- **Calendar:** Google Calendar API (OAuth2, read-only, optional)
- **Storage:** Flat-file JSON in `data/`, preferences in `preferences.md`
- **Credentials:** `.env` file (never committed)
- **PWA:** Service worker + manifest for offline fallback + mobile install

## File structure

```
grocery_agent/
├── server.py              Flask backend — all API endpoints (1161 lines)
├── walmart_tool.py        Walmart API wrapper (RSA auth + product search)
├── test_server.py         Demo server on port 5001 (no API keys needed)
├── run_tests.ps1          Test runner (pytest + node)
├── preferences.md         Household preferences, brand rules, weekly staples (source of truth)
├── requirements.txt       Python dependencies
├── data/
│   ├── recipes.json       Recipe repository (86 seed recipes, ratings, history)
│   ├── pantry.json        Pantry tracker (items, amounts, expiry dates)
│   ├── prefs.json         Saved preferences snapshot (household size, budget, staples)
│   └── google_token.json  Google Calendar OAuth token (optional, gitignored)
├── static/
│   ├── index.html         App shell + step markup + panel overlays
│   ├── app.js             All client-side logic (~3100 lines)
│   ├── style.css          All styles (~660 lines)
│   ├── service-worker.js  PWA service worker (dynamic cache busting)
│   ├── manifest.json      PWA manifest
│   └── photos/            User-uploaded recipe photos
├── tests/
│   ├── test_backend.py    43 pytest tests for Flask endpoints
│   └── test_js_logic.js   27 Node.js tests for pure JS logic
└── .env                   ANTHROPIC_API_KEY, WALMART_CONSUMER_ID, DELIVERY_ZIP, etc.
```

## Server endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Serve index.html |
| GET | `/ping` | Health check |
| GET | `/preferences` | Return preferences.md content |
| GET | `/household-items` | Parse household section of preferences.md |
| GET/POST | `/recipes` | List / add recipe |
| PATCH/DELETE | `/recipes/<id>` | Update / delete recipe |
| POST | `/recipes/<id>/photo` | Upload recipe photo |
| POST | `/recipes/batch-rate` | Bulk update ratings post-order — expects `{"ratings":[...]}` |
| GET | `/recipes/export` | Export recipes as CSV |
| POST | `/recipes/import` | Import recipes from CSV |
| GET/POST | `/pantry` | List / add pantry item |
| PATCH/DELETE | `/pantry/<id>` | Update / delete pantry item |
| POST | `/pantry/batch` | Batch-add items — expects `{"items":[...]}` |
| GET | `/pantry/export` | Export pantry as CSV |
| POST | `/pantry/import` | Import pantry from CSV |
| GET/POST | `/prefs` | Get / save user preferences JSON |
| POST | `/build-cart` | Generate Walmart cart from meals + staples + household items |
| POST | `/swap-item` | Search Walmart for a product by name (inline cart swap) |
| POST | `/claude-prompt` | Proxy a raw prompt to Claude, return text |
| POST | `/generate-single-meal` | Claude generates one new meal suggestion |
| POST | `/generate-recipe` | Claude generates full recipe or easy-mode version |
| POST | `/feedback/order-csv` | Parse Walmart order CSV → pantry items + brand notes |
| POST | `/feedback/order-pdf` | Parse Walmart order PDF receipt → pantry items + brand notes |
| POST | `/recipes/backfill` | Claude generates missing ingredients/steps for recipes |
| GET | `/calendar/status` | Check if Google Calendar is connected |
| GET | `/calendar/auth` | Start Google OAuth flow |
| GET | `/calendar/callback` | OAuth callback |
| GET | `/calendar/week` | Fetch calendar events for a week (`?week=current\|next`) |
| POST | `/calendar/disconnect` | Remove Google token |

## Calendar week parameter

`/calendar/week` accepts `?week=current` (default) or `?week=next`.
Frontend defaults to `next` on Friday, Saturday, and Sunday — Sunday planning loads the upcoming week automatically.

## Cart groups data shape

Each item in `groups` includes `itemId` and `qty` so the frontend can rebuild a filtered Walmart URL excluding deselected items:

```json
{
  "Chicken Pot Pie": [
    {"name": "Perdue Chicken Thighs 2lb", "price": "$6.98", "itemId": "123456", "qty": 1}
  ],
  "staples": [
    {"name": "Whole Milk Gallon", "price": "$4.28", "itemId": "789012", "qty": 1}
  ]
}
```

## Data shapes

```json
// Recipe (data/recipes.json)
{ "id": "1234567890", "name": "Chicken Pot Pie", "rating": 5,
  "tags": ["kid-friendly", "comfort-food"], "notes": "household favorite",
  "timesPlanned": 3, "lastPlanned": "2026-04-27",
  "ingredients": [{"name": "chicken breast", "amount": "1.5 lb"}],
  "steps": ["Preheat oven..."], "photo": "photos/chicken-pot-pie.jpg" }

// Pantry item (data/pantry.json)
{ "id": "1234567890", "name": "ground beef", "amount": "1",
  "unit": "lb", "expiresOn": "2026-05-06", "addedOn": "2026-05-01" }
```

## Key JS state & functions

| Name | What it does |
|------|-------------|
| `calendarWeek` | `'current'` or `'next'`; defaults to `'next'` on Fri/Sat/Sun |
| `setCalendarWeek(week)` | Switches week, re-renders toggle, re-fetches events |
| `_cartDeselected` | `Set` of `"source-origIdx"` keys for unchecked cart items |
| `toggleCartItem(key)` | Toggles deselection; re-renders list, updates total + group subtotals + budget bar |
| `buildFilteredCartUrl()` | Builds Walmart ATC URL from non-deselected items at click-time |
| `_updateCartTotal()` | Recomputes cart total excluding deselected; updates total + budget bar |
| `_updateBudgetBar(n)` | Updates budget bar class + text from a total number |
| `runSanityCheck()` | Informational cart review (no longer blocks Walmart button) |
| `runMealPlan()` | Calls Claude to generate meals; Out days are skipped and enforced post-parse |
| `buildSchedulePrompt()` | Excludes Out days from the Claude prompt |
| `buildFilteredCartUrl()` | Walmart URL rebuilt at click-time with deselected items removed |

## Features implemented

1. **Weekly schedule** — per-day complexity: Quick / Normal / Open / **Out** (no meal needed); Out days excluded from Claude prompt and cart
2. **Google Calendar integration** — OAuth2; maps events to meal complexity; toggle current/next week (defaults to next on Fri–Sun)
3. **Meal plan generation** — Claude selects from top-rated recipes + expiring pantry; Out days enforced post-parse; "include new recipes" toggle; easy-mode per meal
4. **Recipe repository** — full CRUD; 86 seed recipes; star ratings; tags; photo upload; export/import CSV; recipe backfill
5. **Pantry tracker** — add/edit/delete with expiry; color-coded urgency; injected into Claude prompt
6. **Walmart cart building** — parallel Claude + Walmart searches; groups by source; `itemId` + `qty` per item; estimated total
7. **Cart item deselection** — checkbox per item; strikethrough + dim; group subtotals, grand total, and budget bar all update live; deselected items excluded from Walmart URL; deselections survive brand swaps
8. **Brand swap** — inline product search; targeted re-render preserves deselections; budget/total update immediately
9. **Cart review** — informational-only sanity check (duplicates, pantry overlaps, missing staples); never blocks the Walmart button
10. **Budget bar** — live comparison to `budgetTarget` / `budgetMax` from prefs; updates on every deselection
11. **Order feedback** — upload Walmart CSV or PDF; Claude extracts pantry items + brand notes
12. **Household extras checklist** — parsed from `preferences.md`; selections persist in localStorage
13. **Breakfasts / lunches / snacks / dessert** — dropdown pickers added to cart
14. **Holiday planner** — overlay for special occasions
15. **Post-order meal rating** — star ratings feed back into recipe book
16. **PWA** — installable on mobile; offline fallback
17. **Toast notifications** — success/error/undo (3-second restore window on deletes)
18. **Automated tests** — 43 pytest (Flask routes) + 27 Node.js (JS logic); `.\run_tests.ps1`

## Household context

- Family of 4 (2 adults, 2 kids ~age 10 and toddler), Livingston MT 59047
- Kid-friendly meals, comfort food, practical weeknight cooking
- Weekly non-negotiables: bananas, whole milk, Diet Coke 24-pack, distilled water (toddler), coffee
- Brand preferences: Rao's Marinara, Perdue chicken, Sweet Baby Ray's BBQ, Hillshire Farm, Great Value staples
- Walmart for grocery orders (pickup/delivery); zip 59047

## Known constraints

- RSA auth headers expire in 180 seconds — generated fresh per request, never cached
- Walmart Product Search API (not Recipe API) — switched because Recipe API requires special subscription tier
- **Restart server after editing server.py** — runs with `debug=False`, no auto-reload
- `pycryptodome` required (not `pycrypto`) for RSA signing
- Flask CORS required — `index.html` is served from Flask
- Google Calendar integration is optional — app gracefully falls back if not configured
- Timezone: America/Denver (Montana) — configurable in prefs.json
- `batch-rate` endpoint expects `{"ratings": [...]}` wrapper
- `pantry/batch` endpoint expects `{"items": [...]}` wrapper
