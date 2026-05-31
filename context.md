# Grocery Agent — Project Context

Personal weekly grocery planner for Hannah's household in Livingston, MT 59047.
GitHub: https://github.com/hbanthony1/grocery-agent

## What it does

Browser app (served by local Flask server) that handles the full Sunday planning flow:
1. **Your Week** — set per-day schedule complexity, pick breakfasts/lunch/snacks/dessert, review last week's recap, connect Google Calendar
2. **Meal Plan** — Claude generates 7 dinners matched to schedule; swap individual meals from recipe book
3. **Household** — checklist of non-food and extra items to add to cart
4. **Cart** — Walmart product search builds a pre-filled cart URL; open and check out

Post-order: upload Walmart CSV/PDF receipt → auto-update pantry + flag brand preferences.
Meal ratings feed back into future plan generation.

## How to run

```
cd C:\Users\hbant\Documents\grocery_agent
python server.py
# open http://localhost:5000 in browser
```

Demo mode (no API keys needed):
```
python test_server.py
# open http://localhost:5001
```

## Stack

- **Frontend:** Vanilla JS SPA (~3009 lines app.js), no framework, served from Flask
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
├── make_pdfs.py           Markdown-to-PDF converter for guides
├── preferences.md         Household preferences, brand rules, weekly staples (source of truth)
├── design-review.md       UX audit with prioritized improvements
├── requirements.txt       Python dependencies
├── data/
│   ├── recipes.json       Recipe repository (86 seed recipes, ratings, history)
│   ├── pantry.json        Pantry tracker (items, amounts, expiry dates)
│   ├── prefs.json         Saved preferences snapshot (household size, budget, staples)
│   └── google_token.json  Google Calendar OAuth token (optional, gitignored)
├── static/
│   ├── index.html         App shell + step markup + panel overlays (~900 lines)
│   ├── app.js             All client-side logic (~3009 lines)
│   ├── style.css          All styles (~650 lines), Poppins + DM Sans + DM Mono fonts
│   ├── service-worker.js  PWA service worker (dynamic cache busting)
│   ├── manifest.json      PWA manifest
│   └── photos/            User-uploaded recipe photos
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
| POST | `/recipes/batch-rate` | Bulk update ratings post-order |
| GET | `/recipes/export` | Export recipes as CSV |
| POST | `/recipes/import` | Import recipes from CSV |
| GET/POST | `/pantry` | List / add pantry item |
| PATCH/DELETE | `/pantry/<id>` | Update / delete pantry item |
| GET | `/pantry/export` | Export pantry as CSV |
| POST | `/pantry/import` | Import pantry from CSV |
| GET/POST | `/prefs` | Get / save user preferences JSON |
| POST | `/build-cart` | Generate Walmart cart from meals + staples + household items |
| POST | `/swap-item` | Search Walmart for a product by name (inline cart swap) |
| POST | `/feedback/order-csv` | Parse Walmart order CSV → pantry items + brand notes |
| POST | `/feedback/order-pdf` | Parse Walmart order PDF receipt → pantry items + brand notes |
| GET | `/calendar/status` | Check if Google Calendar is connected |
| GET | `/calendar/auth` | Start Google OAuth flow |
| GET | `/calendar/callback` | OAuth callback |
| GET | `/calendar/week` | Fetch calendar events for current or next week (`?week=current\|next`) |
| POST | `/calendar/disconnect` | Remove Google token |

## Calendar week parameter

`/calendar/week` accepts `?week=current` (default) or `?week=next`.
The frontend defaults to `next` on Friday, Saturday, and Sunday so Sunday planning always loads the upcoming week automatically.

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

// Calendar events (/calendar/week response)
{ "Monday": [], "Tuesday": [], "Wednesday": [{"time": "3:30pm", "title": "John guitar"}],
  "Thursday": [{"time": "4pm", "title": "Gracie Vet"}], "Friday": [],
  "Saturday": [], "Sunday": [] }
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
| `loadCalendarStatus()` | Checks Google Calendar connection, loads events if connected |
| `loadCalendarEvents()` | Fetches `/calendar/week?week=<calendarWeek>` and applies complexity |
| `setCalendarWeek(week)` | Switches current/next week, re-renders toggle, re-fetches events |
| `applyCalendarComplexity()` | Sets per-day complexity from calendar events (busy day = Quick) |
| `toggleRecipesPanel()` | Opens/closes recipe book overlay |
| `togglePantryPanel()` | Opens/closes pantry overlay |
| `parseOrderFeedback()` | POSTs receipt CSV/PDF to server, auto-adds items to pantry |
| `cycleComplexity(day)` | Manually toggle a day's complexity Quick→Normal→Open→Quick |

## Features implemented

1. **Weekly schedule** — per-day complexity (Quick/Normal/Open); injected into Claude prompt
2. **Google Calendar integration** — OAuth2, read-only; maps events to meal complexity (busy = Quick); toggle to view current or next week (defaults to next week Fri–Sun)
3. **Meal plan generation** — Claude selects from top-rated recipes + expiring pantry items; supports "include new recipes" toggle; easy-mode per meal
4. **Recipe repository** — full CRUD panel; 86 seed recipes; star ratings; tags; photo upload; export/import CSV; recipe backfill (Claude generates ingredients + steps)
5. **Pantry tracker** — add/edit/delete items with expiry; color-coded urgency (red/orange/yellow); expiring items flagged in Claude prompt
6. **Walmart cart building** — parallel Claude + Walmart Product Search API calls per meal; staples, household items, breakfasts, lunches, snacks, dessert all supported; grouped by source; estimated total
7. **Cart sanity check** — detects and consolidates duplicate ingredients across meals
8. **Item swap** — inline product search to replace any cart item
9. **Order feedback** — upload Walmart CSV or PDF receipt; Claude extracts pantry items with shelf-life estimates and brand notes
10. **Household extras checklist** — parsed from `preferences.md`; selections persist in localStorage
11. **Breakfasts / lunches / snacks / dessert** — dropdown pickers, not AI-generated; added to cart
12. **Holiday planner** — overlay for special occasions (Thanksgiving, Christmas, etc.)
13. **Post-order meal rating** — star ratings after checkout feed back into recipe book
14. **PWA** — installable on mobile; offline fallback (demo mode via service worker)
15. **Toast notifications** — success/error/undo (3-second restore window on deletes)

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
- Flask CORS required — `index.html` is served from Flask but Walmart calls go through it
- Google Calendar integration is optional — app gracefully falls back if not configured
- Timezone: America/Denver (Montana) — configurable in prefs.json
