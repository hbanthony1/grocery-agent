# Grocery Agent — User Guide

A weekly meal planner and Walmart cart builder for your household. Every Sunday, it suggests 7 dinners based on your preferences, finds the ingredients on Walmart, and generates a cart link you click to check out.

Total time per week: about 5 minutes.

---

## Starting the app

The app needs a small server running in the background to talk to Walmart. You start it once and leave it open while you plan your week.

1. Open **PowerShell** (search for it in the Windows Start menu)
2. Type the following and press Enter:
   ```
   cd C:\Users\hbant\Documents\grocery_agent
   python server.py
   ```
3. You'll see: `Grocery agent server running at http://localhost:5000`
4. Open your browser and go to **http://localhost:5000**

Leave PowerShell open the whole time. When you're done for the week, close it.

---

## The three-step flow

The app walks you through three steps shown at the top of the page:

**1 → preferences → 2 → meal plan → 3 → cart**

Each step must be completed before moving to the next. Completed steps show a checkmark.

---

## Step 1 — Preferences

This step is your starting point every week. It shows a summary of your saved preferences and lets you set up this week's schedule.

### Your preferences summary

The top card shows a snapshot of your saved preferences:
- Household size and zip code
- Weekly budget target
- Number of weekly staples
- Number of brand rules
- Any meals you've marked to skip this week

To change anything, click **edit preferences →** (see Preferences Editor below).

### Include new recipes toggle

Below the summary, there's a checkbox: **"Include 1–2 new recipes we haven't tried before."**

- Checked (default): Claude will suggest 2 brand-new meals alongside your family favorites. New meals are marked with a **✦ new** badge in the meal plan.
- Unchecked: all 7 meals will come from your existing recipe book and favorites.

### This week's schedule

Each day of the week has a complexity setting that tells Claude how much cooking time is realistic that evening.

Click the colored button next to any day to cycle through three options:

| Setting | What it means |
|---------|---------------|
| **Quick** | 30 minutes or less — frozen, heat-and-eat, or simple assembly |
| **Normal** | Standard weeknight — 30 to 60 minutes |
| **Open** | Plenty of time — elaborate recipes welcome (lasagna, slow cooker, pot roast, etc.) |

Friday defaults to **Quick**, Saturday and Sunday to **Open**. Adjust based on your actual week.

You can also type a short note next to any day (e.g., "soccer game at 6" or "guests for dinner").

### Household items

The bottom card shows non-grocery items you might need this week — things like dish soap, paper towels, shampoo, or kids' items. These come from your preferences.

Check the ones you need. The count updates as you select. These get added to your Walmart cart alongside the groceries.

Your selections are remembered between sessions, so you only need to uncheck things you don't need, not re-check everything each week.

### Generating the meal plan

When your schedule is set, click **Generate meal plan →**.

---

## Step 2 — Meal Plan

Claude generates 7 dinners — one per day of the upcoming week — based on your preferences, schedule, recipe book, and pantry.

This usually takes 5–10 seconds.

### Reading the meal cards

Each meal card shows:

- **Day badge** — the day abbreviation and calendar date (e.g., Mon 12)
- **Meal name** — the suggested dinner
- **✦ new badge** — appears if this is a brand-new recipe your family hasn't made before
- **Tags** — pulled from your recipe book if the meal appears there (e.g., *quick*, *kid-friendly*)
- **Complexity pill** — matches what you set for that day in the schedule (Quick / Normal / Open)

### Swapping a meal

If you don't want a suggested meal, click the **↺** button on its card.

A swap panel appears below the cards with two options:

1. **From your recipe book** — your saved recipes appear sorted by rating. Click one to swap it in.
2. **Type a meal** — type any meal name in the text field and click **swap**.

Click **cancel** to close the swap panel without changing anything.

You can swap as many meals as you want before approving.

### Approving the plan

When you're happy with the 7 meals, click **Approve & build cart →**.

---

## Step 3 — Cart

The app contacts Walmart, finds every ingredient for your 7 meals, and builds a cart link. This takes about 30 seconds.

You'll see a progress message while it works: *"Building Walmart cart..."*

### Cart summary

Once the cart is ready, you'll see:
- A list of every item Walmart matched for your meals, with prices
- An **estimated total** at the bottom

Prices are estimates based on current Walmart availability at your zip code.

### Opening your Walmart cart

Click **Open in Walmart →** to open a pre-filled Walmart cart in a new browser tab.

The cart will already contain all your ingredients and any household items you selected. You review everything in Walmart, make any adjustments (add more, remove things you already have), and check out normally.

**The app does not place the order** — it just opens a pre-filled cart. You confirm and pay on Walmart.com.

### Confirming the order

Once you've placed the order in Walmart, come back to the app and click **Confirm order ✓**.

This unlocks the rating panel.

### Rating this week's meals (optional)

After confirming, a rating panel appears where you can give each meal a star rating (1–5 stars).

This is optional but worth doing — ratings are saved to your recipe book and help Claude prioritize your family's favorites in future weeks.

Click **save to recipe book →** to save your ratings, or **skip** to close the panel without saving.

---

## Recipe Book

Click **recipe book** in the header to open your recipe book panel. It slides in from the right and stays open while you navigate.

Your recipe book stores meals your family has made, along with ratings, tags, and notes. Claude reads this when generating meal plans and prioritizes highly-rated recipes.

### Viewing and searching

Recipes are sorted by rating (highest first), then by how often they've been planned. Use the search bar to filter by name or notes.

### Adding a recipe manually

Click **+ add** to add a recipe. Fill in:
- **Name** — the meal name
- **Stars** — click to set a rating
- **Notes** — anything useful (e.g., "use store brand pasta, kids love the garlic bread version")
- **Tags** — check any that apply: *quick*, *weekend*, *kid-friendly*, *comfort-food*

Click **add recipe** to save it.

### Editing or removing a recipe

Click **edit** on any recipe card to update the name, rating, notes, or tags. Click **save** when done.

Click **×** to permanently remove a recipe.

---

## Pantry

Click **pantry** in the header to open the pantry panel.

The pantry tracks what you already have at home so Claude can incorporate those ingredients into meal suggestions and avoid buying duplicates.

### Adding a pantry item

Click **+ add** and fill in:
- **Item name** — what it is (e.g., "chicken breasts", "heavy cream")
- **Amount and unit** — optional (e.g., "2 lbs", "1 carton")
- **Expiry date** — optional, but helps with urgency sorting

### Expiry color coding

Items are color-coded by how soon they expire:
- **Red left border** — expired or expiring within 3 days (use immediately)
- **Yellow left border** — expiring within a week
- **No accent** — fine, no urgency

Expired and soon-to-expire items sort to the top. Claude sees these and will suggest meals that use them up first.

### Editing or removing pantry items

Click **edit** on any item to update it. Click **×** to remove it when you've used it up or thrown it out.

---

## Preferences Editor

Click **edit preferences →** from the Step 1 screen to open the full preferences editor.

Changes here are saved to your computer and used every time you generate a meal plan.

### Household

- **Adults / Kids** — number of people
- **Kids ages** — a short description (e.g., "ages ~10 and toddler") used to keep meals age-appropriate
- **Zip code** — your delivery zip for Walmart pricing
- **Budget target / max** — Claude uses these when planning meals

### Diet & preferences

A list of dietary notes that Claude follows when suggesting meals. Examples:
- "No shellfish"
- "One vegetarian meal per week"
- "Kids don't like spicy food"

Click **+ add note** to add a new one. Click **×** to remove.

**General notes** — a free-text field for anything else (e.g., "we're trying to eat less red meat" or "husband is on a low-sodium diet").

### Weekly staples

Items you buy every single week regardless of the meal plan — milk, eggs, bread, bananas, etc. These are always added to your Walmart cart.

### Frequent staples

Items you usually need most weeks. These are included in your order unless you remove them.

### Brand rules

Specific brands you always want for certain items. Format: item → brand.

Example: *cheese → Tillamook*, *olive oil → California Olive Ranch*

**Store brand / Great Value ok for** — a text field listing categories where you're fine with the generic option (e.g., "flour, pasta, canned goods, frozen vegetables").

### Do not repeat this week

Meals you've had recently that you don't want repeated in this week's plan. Add them here each week, or clear them out when you're ready to have them again.

### Household & non-grocery items

The list of non-grocery items that appear in the household items section on Step 1. Edit this to add or remove things like paper towels, dish soap, shampoo, etc.

### Saving

Click **Save →** at the top or bottom of the editor. The app saves your preferences and returns you to Step 1.

---

## Tips

**Update "do not repeat" every week.** Without it, Claude will rotate the same meals. A quick habit of adding last week's meals before you generate takes 30 seconds.

**Rate your meals.** Even a quick 3-star / 5-star click after the week goes a long way. Claude prioritizes highly-rated recipes and the plan gets more accurate over time.

**Use the pantry.** If you have chicken thighs, spinach, or anything that needs to be used up, add it to the pantry with an expiry date. Claude will work it into the week's meals.

**Adjust the schedule.** A busy Wednesday gets a 30-minute meal. An open Saturday gets something more involved. The more accurate the schedule, the better the suggestions.

**The cart takes about 30 seconds.** It's matching ingredients across 7 meals in real time — this is normal. Don't close the tab while it loads.

**Keep PowerShell open.** If you close the terminal window, the server stops and the cart builder won't work. You can minimize it, just don't close it until you're done.
