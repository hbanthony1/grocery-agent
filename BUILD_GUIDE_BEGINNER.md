# How to Build a Grocery Agent That Orders from Walmart — Beginner's Guide

This is a step-by-step guide for someone with no coding experience. You'll build a personal website that runs on your own computer, suggests weekly meals based on your family's preferences, and builds a Walmart grocery cart with one click.

Claude writes all the code. Your job is to set up the accounts, describe what you want, and test it in your browser.

---

## What you're building

A three-step app that lives in your browser:

1. **Preferences** — your household details, dietary notes, and what you need every week
2. **Meal plan** — Claude AI suggests 7 dinners based on your preferences. You can approve, swap, or change any of them.
3. **Cart** — the app finds every ingredient on Walmart.com and generates a link that opens a pre-filled Walmart cart. You review it and check out like normal.

Total time to use it once it's built: about 5 minutes on a Sunday morning.

---

## Before you start — accounts and software to set up

Do this once. It takes about 30–45 minutes.

---

### 1. Install Python

Python is the engine that runs the app behind the scenes. You don't need to write any Python — Claude does that.

- Go to **python.org** → Downloads → Download Python 3 (the latest version)
- Run the installer
- **Important:** On the first screen of the installer, check the box that says **"Add Python to PATH"**
- Click through the rest and finish the install

To confirm it worked: open Terminal (on Windows, search for "PowerShell" in the Start menu), type `python --version`, and press Enter. You should see something like `Python 3.12.3`.

---

### 2. Install Claude Code

Claude Code is the version of Claude that can read and write files on your computer directly — so it can actually build the app, not just describe it.

- Open a browser and search for "Claude Code install" or go to **claude.ai/code**
- Follow the install instructions for your computer (Windows or Mac)
- When it's installed, open Terminal and type `claude` to start it

---

### 3. Get an Anthropic API key

This lets the app call Claude AI to generate meal plans. Think of it like a password that lets your app use Claude.

- Go to **console.anthropic.com**
- Sign up for an account
- Click "API Keys" → "Create Key"
- Copy the key and save it somewhere safe (like a notes app). It starts with `sk-ant-...`
- You'll need to add a small amount of credit (a few dollars — meal planning uses very little)

---

### 4. Create a Walmart Developer account

This is how the app talks to Walmart. Walmart has a free developer program for exactly this kind of personal use.

- Go to **walmart.io**
- Click "Sign Up" and create a developer account
- Once logged in, click "Create an Application" and fill out the form (it's a personal project, so keep it simple)
- After your app is created, download your **Private Key** (.pem file) — this is like your Walmart password. Keep it safe and never share it.
- Copy your **Consumer ID** from the app details page

---

### 5. Create a folder for your project

On your computer, create a new folder. Name it `grocery_agent`. Put it somewhere easy to find, like your Documents folder.

This folder will hold everything Claude builds.

---

### 6. Create a `.env` file

A `.env` file stores your passwords so the app can use them without you having to type them every time. It also makes sure they never end up somewhere public.

Inside your `grocery_agent` folder, create a new text file called `.env` (just that — a dot and then "env", no other extension). Open it and paste this in, replacing the placeholder values with your real ones:

```
ANTHROPIC_API_KEY=sk-ant-your-key-here
WALMART_CONSUMER_ID=your-consumer-id-here
WALMART_PRIVATE_KEY_PATH=C:\Users\YourName\Documents\grocery_agent\walmart_private_key.pem
WALMART_PRIVATE_KEY_VERSION=1
WALMART_PUBLISHER_ID=
DELIVERY_ZIP=your-zip-code-here
```

Move your downloaded `.pem` file into the `grocery_agent` folder and update the path above to match where it actually is.

---

### 7. Create a `CLAUDE.md` file

This is a cheat sheet that Claude reads at the start of every session so you don't have to re-explain the project. Create a file called `CLAUDE.md` in your `grocery_agent` folder and paste this in:

```
# CLAUDE.md — Grocery Agent

## What this is
A weekly meal planner and Walmart cart builder for personal household use.
It runs locally on my computer. I open it in my browser on Sunday mornings.

## How to run it
Open Terminal → cd into grocery_agent folder → python server.py
Then open http://localhost:5000 in the browser.

## My household
- 2 adults, 2 kids
- Location: [your city, state, zip]

## Stack
- Python Flask backend on port 5000
- Vanilla JavaScript frontend (no framework)
- Anthropic API for meal planning (claude-sonnet-4-6)
- Walmart Recipe API + Add to Cart API for building the cart
- Flat JSON files in data/ for storing recipes, pantry, preferences
- Credentials in .env (never commit this file)

## Things to always know
- Never commit .env or walmart_private_key.pem
- Use pycryptodome, NOT pycrypto — they have the same import name but pycrypto is broken
- The Walmart auth signature expires in 180 seconds — always generate it fresh before each API call
- The Add to Cart URL does NOT place an order — the user opens it and checks out themselves
- server.py only needs to run during the ~5 minutes of weekly planning
```

---

## Now build the app — one feature at a time

Open Terminal, navigate to your project folder, and start Claude Code:

```
cd C:\Users\YourName\Documents\grocery_agent
claude
```

Then paste in each prompt below, one session at a time. Wait until one feature works before starting the next.

---

### Session 1 — Build the skeleton

Paste this into Claude Code:

```
I want to build a weekly grocery planning app with a Walmart cart builder.

Here's the full project context:
[paste your CLAUDE.md contents here]

For this first session, just build the skeleton — a working shell I can open in my browser.

Create:
- server.py: Flask app on port 5000, with a /ping health check that returns {"ok": true}
- static/index.html: basic three-step layout (Preferences, Meal Plan, Cart) with placeholder content
- static/app.js: basic state and navigation between the three steps
- static/style.css: clean, simple base styles
- requirements.txt: list of Python packages needed
- .gitignore: exclude .env and walmart_private_key.pem

Don't build the Walmart API or meal planning yet — just a shell that opens and looks right.
```

When Claude finishes, run the app:

1. In Terminal: `pip install -r requirements.txt`
2. Then: `python server.py`
3. Open your browser to `http://localhost:5000`

You should see a basic three-step layout. Tell Claude if anything looks off.

---

### Session 2 — Preferences page

Your preferences tell Claude what your family likes to eat, what you always need, and any rules (no shellfish, always buy organic milk, etc.).

Paste this into a new Claude session (always start by pasting your CLAUDE.md):

```
[paste CLAUDE.md contents]

Add the Preferences step to the grocery agent.

It should have:
- Household info: number of adults, number of kids, kids' ages, zip code, weekly budget
- Dietary notes: a list of items I can add/remove (e.g. "no shellfish", "one vegetarian meal per week")
- Weekly staples: things I buy every single week (milk, eggs, bananas, etc.)
- Frequent staples: things I buy most weeks
- Brand rules: specific brands I prefer for certain items (e.g. "Tillamook for cheese")
- Do not repeat: meals I already had recently and don't want again this week
- General notes: anything else the meal planner should know

Store everything in data/prefs.json. Add GET /prefs and POST /prefs endpoints to server.py.

Show a clean summary of preferences on the main screen with an "edit preferences" button that opens a full editor.
```

When it's done, open the app, fill in your preferences, and save them. Check that they look right.

---

### Session 3 — Meal plan generation

This step uses Claude AI to suggest 7 meals based on your preferences.

```
[paste CLAUDE.md contents]

Add meal plan generation to the grocery agent.

When the user clicks "Generate meal plan":
- Read preferences from data/prefs.json
- Call the Anthropic API with a prompt that includes: household size, dietary notes, do-not-repeat list, schedule for the week (which evenings are busy vs. free)
- Get back 7 dinner suggestions with: meal name, estimated cook time, complexity (quick/normal/open-ended)
- Display them in a grid — one per day of the upcoming week
- Let the user swap any meal by clicking it and either typing a replacement or picking from their recipe book
- Show an "Approve & build cart" button once they're happy

Use claude-sonnet-4-6 for the API call.
```

Test it: click Generate, see if the meals look reasonable, try swapping one.

---

### Session 4 — Walmart cart builder

This is the most complex part. It connects to Walmart to find every ingredient and build a cart link.

```
[paste CLAUDE.md contents]

Add the Walmart cart builder to the grocery agent.

Here's how the Walmart API works:

1. Auth: Walmart uses RSA-SHA256 signing. Use pycryptodome (not pycrypto). Generate fresh auth headers before every API call — they expire in 180 seconds.

2. For each approved meal:
   a. Call the Anthropic API to generate a structured ingredient list (name, quantity, unit) for that meal for a family of [household size]
   b. POST to https://developer.api.walmart.com/api-proxy/service/recipe/v1/register with the meal title and ingredients to get a recipeId
   c. GET from /recipe/v1/products?recipeId=...&zipCode=... to get matched Walmart products and prices

3. Also search for weekly staples from prefs.json using the Walmart search API.

4. Build a cart URL: https://affil.walmart.com/cart/addToCart?recipeIds=id1,id2,...&items=itemId|qty,...
   This URL opens a pre-filled Walmart cart when the user clicks it. It does NOT place an order.

5. Show the user:
   - A list of all items with prices
   - An estimated total
   - An "Open in Walmart" button with the cart URL

Add a POST /build-cart endpoint to server.py that does all of this.
Credentials come from .env (WALMART_CONSUMER_ID, WALMART_PRIVATE_KEY_PATH, WALMART_PRIVATE_KEY_VERSION).
```

Test it: approve a meal plan, click "Build cart", check that the Walmart link opens with real groceries in the cart.

---

### Session 5 — Recipe book and pantry (optional but useful)

```
[paste CLAUDE.md contents]

Add two panel features:

1. Recipe book: a slide-in panel showing all meals we've made before, stored in data/recipes.json. 
   - Show each recipe with: name, tags (quick/vegetarian/family-favorite/etc.), last made date, rating
   - Let me add recipes manually or save them automatically when a meal plan is approved
   - The meal plan generator should prefer highly-rated recipes

2. Pantry tracker: a slide-in panel showing what's already in the fridge/pantry, stored in data/pantry.json.
   - Let me add items with a name and urgency level (use soon / have plenty / out)
   - The meal plan generator should factor in what we already have
   - Show items color-coded by urgency

Both panels open as overlays from buttons in the header.
```

---

## Running the app every week

Once it's built, your Sunday routine is:

1. Open Terminal → type `python server.py` → press Enter
2. Open your browser to `http://localhost:5000`
3. Check the schedule card — mark which evenings are busy
4. Click "Generate meal plan"
5. Swap any meals you don't want
6. Click "Approve & build cart"
7. Click "Open in Walmart →"
8. Review the cart in Walmart and check out
9. Close Terminal when you're done

---

## Common problems and fixes

**"python is not recognized" when I run the server**
Python isn't in your PATH. Reinstall Python and make sure to check "Add Python to PATH" during install.

**"Module not found" error when starting server.py**
You need to install the required packages. In Terminal, run: `pip install -r requirements.txt`

**The app opens but the meal plan button doesn't do anything**
Make sure server.py is running in Terminal. It needs to be open in the background while you use the app.

**The Walmart cart link opens but has wrong items or is empty**
This usually means the Walmart API couldn't find matching products for your zip code. Try running the cart again. Some specialty ingredients won't match — that's normal.

**"Invalid signature" error from Walmart**
Your computer's clock may be slightly off, or the credentials in your `.env` file aren't quite right. Double-check that your Consumer ID and .pem file path are correct.

**I don't see my preferences after saving them**
Refresh the page. Preferences are saved to a file and re-loaded when the page loads.

**Claude is suggesting meals we don't like**
Go to Preferences and add them to the "Do not repeat" list, or add a note in the general notes section. The more specific you are, the better Claude's suggestions get.

---

## Tips from experience

**Give Claude feedback in plain English.** "The buttons are too small on my laptop" or "I'd like the meal cards to show the day of the week" is all you need. You don't need to know any technical terms.

**One feature at a time.** Trying to build everything in one session leads to mistakes. Do one thing, test it in your browser, then move to the next.

**If something breaks, describe exactly what happened.** "I clicked the cart button and got a white screen" is helpful. "It's not working" is not. The more specific you are, the faster Claude can fix it.

**Save your work after each feature.** In Terminal, run:
```
git add .
git commit -m "added meal plan step"
git push
```
If Claude ever breaks something, you can go back to the last working version.

**Start fresh with CLAUDE.md every session.** At the start of every new Claude Code session, paste your CLAUDE.md contents first. This saves you from re-explaining the project.

---

## What your finished project folder looks like

```
grocery_agent/
├── server.py                    ← the engine (Claude manages this)
├── walmart_tool.py              ← the Walmart API connector
├── static/
│   ├── index.html               ← what you see in the browser
│   ├── app.js                   ← the interactive behavior
│   └── style.css                ← the visual design
├── data/
│   ├── prefs.json               ← your household preferences
│   ├── recipes.json             ← your recipe book
│   └── pantry.json              ← your pantry tracker
├── CLAUDE.md                    ← project cheat sheet for Claude
├── requirements.txt             ← Python packages list
├── .env                         ← your passwords (never share this)
└── walmart_private_key.pem      ← your Walmart key (never share this)
```

You never need to open or edit any of these files yourself. Claude reads and updates them. You just use the app in your browser.

---

## Before your first Claude session — checklist

- [ ] Python installed with "Add to PATH" checked
- [ ] Claude Code installed
- [ ] Anthropic account created, API key saved
- [ ] Walmart.io account created, Consumer ID copied, .pem file downloaded
- [ ] `grocery_agent` folder created
- [ ] `.env` file created with all four credentials filled in
- [ ] `.pem` file moved into the `grocery_agent` folder
- [ ] `CLAUDE.md` created with your household info filled in
