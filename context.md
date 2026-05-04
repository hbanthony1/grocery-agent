# Grocery Agent — Project Context

Personal weekly grocery planner for Hannah's household in Livingston, MT 59047.
GitHub: https://github.com/hbanthony1/grocery-agent

## What it does

Browser app (served by local Flask server) that handles the full Sunday planning flow:
1. Load preferences + set weekly schedule + select household items
2. Claude generates a 7-dinner meal plan matched to each day's schedule complexity
3. Approve/swap meals, then build a Walmart cart via the Product Search API
4. Get a pre-filled Walmart cart URL to open and check out
5. Rate meals after the week — ratings feed back into future meal plans

## How to run

```
cd C:\Users\hbant\Documents\grocery_agent
python server.py
# open http://localhost:5000 in browser
```

## Stack

- **Frontend:** Vanilla JS single-page app, no framework, served from Flask
- **Backend:** Python Flask (port 5000), proxies all Walmart API calls
- **AI:** Anthropic API (`claude-sonnet-4-6`) — meal plan generation, ingredient query generation
- **Walmart:** Product Search API (`/affil/product/v2/search`) with RSA-SHA256 auth
- **Storage:** Flat-file JSON (`data/recipes.json`, `data/pantry.json`)
- **Credentials:** `.env` file (never committed)

## File structure

```
grocery_agent/
├── server.py              Flask backend — all API endpoints
├── walmart_tool.py        Walmart API wrapper (search_product, build_cart_url)
├── preferences.md         Household preferences, brand rules, weekly staples
├── data/
│   ├── recipes.json       Recipe repository (CRUD, persists ratings)
│   └── pantry.json        Pantry tracker (items, amounts, expiry dates)
├── static/
│   ├── index.html         App shell + step markup + panel overlays
│   ├── app.js             All client-side logic (~700 lines)
│   └── style.css          All styles (~190 lines), DM Sans + DM Mono fonts
└── .env                   ANTHROPIC_API_KEY, WALMART_CONSUMER_ID, etc.
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
| GET/POST | `/pantry` | List / add pantry item |
| PATCH/DELETE | `/pantry/<id>` | Update / delete pantry item |
| POST | `/build-cart` | Generate Walmart cart from meals + household items |

## Data shapes

```json
// Recipe (data/recipes.json)
{ "id": "1234567890", "name": "Chicken Pot Pie", "rating": 5,
  "tags": ["kid-friendly", "comfort-food"], "notes": "household favorite",
  "timesPlanned": 3, "lastPlanned": "2025-04-27" }

// Pantry item (data/pantry.json)
{ "id": "1234567890", "name": "ground beef", "amount": "1",
  "unit": "lb", "expiresOn": "2025-05-06", "addedOn": "2025-05-01" }
```

## Key JS functions

| Function | What it does |
|----------|-------------|
| `runMealPlan()` | Calls Claude API to generate 7-meal plan |
| `buildRecipeRepoPrompt()` | Injects top 15 rated recipes into Claude prompt |
| `buildPantryPrompt()` | Injects expiring/stocked items into Claude prompt |
| `buildSchedulePrompt()` | Injects per-day complexity (Quick/Normal/Open) into Claude prompt |
| `approveMealPlan()` | POSTs to `/build-cart`, renders cart summary |
| `renderSwapPicker()` | Shows recipe book suggestions when swapping a meal |
| `showRatingPanel()` | Post-order star ratings that write back to recipe book |
| `toggleRecipesPanel()` | Opens/closes recipe book overlay |
| `togglePantryPanel()` | Opens/closes pantry overlay |

## Features implemented

1. **Weekly schedule** — per-day complexity toggle (Quick / Normal / Open) with optional notes; injected into meal plan prompt so Claude matches meal effort to available time
2. **Household items checklist** — parses `## Household / non-grocery` section from preferences.md; selections persist in localStorage and are added to the Walmart cart
3. **Recipe repository** — full CRUD panel; pre-seeded with 14 household favorites; star ratings; tags (quick, weekend, kid-friendly, comfort-food); top-rated recipes injected into Claude prompt; swap picker shows recipe book matches; post-order rating panel
4. **Pantry tracker** — add items with amount, unit, expiry date; color-coded urgency (red = expired, orange ≤3 days, yellow ≤7 days); expiring items flagged in Claude prompt as "use these up first"; stocked items listed to avoid duplicate purchases

## Household context

- Family of 4, Livingston MT 59047
- Kid-friendly meals, comfort food, practical weeknight cooking
- Prefers Walmart for grocery orders (pickup/delivery)
- Brand preferences: Rao's Marinara, Prego pasta sauce, Nathan's hot dogs, Hillshire Farm, Stonefire naan
- Weekly staples defined in preferences.md (auto-added to every cart via Claude extraction)
- Walmart search uses descriptive terms, not brand names (exceptions: Rao's, Prego)

## Known constraints

- RSA auth headers expire in 180 seconds — generated fresh per request, never cached
- Walmart Product Search API (not Recipe API) — switched because Recipe API requires special subscription
- Flask debug mode restarts on file changes — restart server after editing server.py
- `pycryptodome` required (not `pycrypto`) for RSA signing
- Anthropic API key used in browser-side JS for meal plan generation (served from Flask, so key stays server-side via `/preferences` endpoint pattern is fine)
