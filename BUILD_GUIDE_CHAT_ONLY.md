# Grocery Planning with Claude Chat — No Code Required

This is the simplest possible version: no installation, no server, no code. Just Claude and a conversation. You'll get a weekly meal plan and a organized shopping list in about 2 minutes.

What you can do this way:
- Get 7 dinner suggestions tailored to your family every week
- Get a full shopping list grouped by store section (produce, dairy, meat, etc.)
- Swap meals you don't want
- Factor in what's already in your pantry
- Build on a recipe book of meals your family loves

What you can't do this way:
- Automatically build a Walmart cart (that requires code)
- Track pantry inventory over time
- Save your recipe history automatically

---

## One-time setup — 20 minutes

### Step 1: Create a Claude account

Go to **claude.ai** and sign up. The free plan works fine for this. Claude Pro ($20/month) gives you faster responses and more usage if you find yourself hitting limits.

### Step 2: Create a Project

Projects are Claude's way of remembering your context across conversations. Instead of re-explaining your family's preferences every week, you set it up once and Claude knows it every time.

- Click **"Projects"** in the left sidebar
- Click **"New Project"**
- Name it something like "Weekly Grocery Planning"

### Step 3: Write your preferences file

Inside your project, click **"Add content"** or **"Project instructions."** This is where you tell Claude everything about your household once, so it never has to ask again.

Copy the template below and fill it in with your own details:

---

```
# My Household Grocery Preferences

## Household
- Adults: 2
- Kids: 2 (ages: ~10 and toddler)
- Location: Livingston, MT 59047
- Weekly grocery budget: $175 target, $225 max

## Dietary notes
- No shellfish
- One vegetarian meal per week preferred
- Toddler is a picky eater — needs simple, recognizable food
- Husband doesn't like anything too spicy
- We like trying one new recipe most weeks

## Meals we make regularly (recipe book)
- Chicken tacos
- Spaghetti with meat sauce
- Sheet pan salmon with vegetables
- Chicken stir fry
- Homemade pizza
- Black bean soup
- Pot roast (Sunday only — takes all day)
- Chicken and rice
- Beef tacos
- Grilled cheese and tomato soup
[add your own family favorites here]

## Weekly staples — I always need these
- Milk (1 gallon, whole)
- Eggs (1 dozen)
- Bread (sandwich loaf)
- Bananas
- Apples
- Baby carrots
- Cheddar cheese (block)
- Butter

## Frequent staples — I usually need these
- Greek yogurt
- Orange juice
- Lunch meat
- Tortillas

## Brand preferences
- Tillamook for cheese and butter
- Organic for: spinach, apples, strawberries
- Store brand is fine for: flour, sugar, pasta, canned tomatoes, frozen vegetables

## Meals to avoid repeating
[update this each week before you generate a plan]
- [last week's meals go here]
```

---

Paste your filled-in version into the Project instructions and save it.

---

## Every week — Sunday morning routine

Open your Grocery Planning project in Claude and paste this prompt. Customize the parts in brackets before sending.

---

**Your weekly prompt:**

```
Generate this week's meal plan.

This week's schedule:
- Monday: busy evening (need something quick, 30 min or less)
- Tuesday: free
- Wednesday: busy (quick meal)
- Thursday: free
- Friday: pizza night (already planned)
- Saturday: free — good night for something more involved
- Sunday: [busy/free]

What's already in my fridge/pantry that needs to be used up:
- [e.g. half a rotisserie chicken, a bag of spinach that needs to go]
- [or: nothing in particular]

Meals to avoid this week (we just had these):
- [e.g. tacos, spaghetti]

Anything special this week:
- [e.g. "guests on Saturday" or "trying to keep it under $150" or nothing]

Please give me:
1. A meal plan — one dinner per day with the meal name, estimated cook time, and a note on complexity
2. A full shopping list organized by store section (produce, meat, dairy, dry goods, frozen, household)
3. Flag anything from my weekly staples that I should grab
```

---

That's the whole routine. Claude will respond with something you can screenshot or copy into your notes app to take to the store.

---

## Swapping a meal you don't want

After Claude gives you the plan, just reply:

```
I don't want [meal name] this week. Swap it for something different — we haven't had [alternative idea] in a while, or suggest something else.
```

Or if you want to use something specific:

```
Replace Thursday's meal with chicken stir fry. Update the shopping list to match.
```

---

## If you use the Walmart app

The shopping list Claude gives you is organized by category, which maps pretty well to how Walmart is laid out. You can:

- Screenshot it and reference it while shopping in-store
- Copy it into the Walmart app's list feature manually
- Read it off your phone while adding items to your online cart

It's more manual than the automated version, but it still saves the mental work of figuring out what to cook and what to buy.

---

## Saving meals your family loved

At the end of the week, tell Claude which meals were a hit:

```
This week went well. Add these to our regular rotation:
- [meal name] — the kids loved it
- [meal name] — easy and everyone ate it

Skip these in the future:
- [meal name] — nobody liked it
```

Claude will remember this within the Project and factor it into future weeks.

---

## Tips

**Be specific about your schedule.** "Busy Monday" makes a big difference — Claude will suggest a slow cooker or sheet pan meal that cooks itself, instead of something that takes 45 minutes of active cooking.

**Tell Claude what's in your fridge.** "I have half a bag of spinach and some chicken thighs that need to be used" will get you meals that use those things up first.

**Update "meals to avoid" every week.** This is the most important line in the prompt. Without it, Claude will repeat the same 5 meals in rotation.

**The more you use it, the better it gets.** As you add to your recipe list and tell Claude what hit and what didn't, it builds a better picture of what your family actually eats.

---

## When you're ready for the automated version

The chat-only approach handles the thinking part — what to cook, what to buy. The only step it can't automate is actually building the Walmart cart.

When you're ready to add that, see **BUILD_GUIDE_BEGINNER.md** in this folder. It walks you through building the full app with Python and Claude Code. The preferences format you've built up here transfers directly — you'd just move your preferences from Claude's Project into the app's preferences editor.
