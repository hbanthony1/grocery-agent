# How to Build a Personal Tool with Claude

This is a practical guide based on building the Grocery Agent — a weekly meal planner and Walmart cart builder. The same approach works for any personal web tool: a budget tracker, home inventory, workout planner, etc.

---

## What you're building

A browser app served by a local Flask server, built feature-by-feature in conversation with Claude Code. No framework, no deployment, no ops. It runs on your computer when you need it and does exactly one thing well.

**Stack that works well for this:**
- Python Flask (local server, port 5000)
- Vanilla JS single-page app (no framework)
- Flat JSON files for storage (`data/recipes.json`, `data/pantry.json`, etc.)
- Anthropic API for any AI features
- External API of your choice (Walmart, Google Calendar, Notion, etc.)
- `.env` for credentials

---

## Step 1: Write your CLAUDE.md before anything else

This file lives in your project root and tells Claude everything about the project. It's re-read at the start of every session. The more specific it is, the less you have to re-explain.

**Template:**

```markdown
# CLAUDE.md

## What this project is
[One paragraph: what it does, who it's for, why it exists]

## How to run it
\`\`\`
cd /path/to/project
python server.py
# open http://localhost:5000
\`\`\`

## Stack
- Frontend: Vanilla JS SPA, served from Flask
- Backend: Python Flask (port 5000)
- AI: Anthropic API (claude-sonnet-4-6)
- Storage: Flat-file JSON in data/
- Credentials: .env file (never commit)

## File structure
\`\`\`
project/
├── server.py
├── static/
│   ├── index.html
│   ├── app.js
│   └── style.css
├── data/
│   └── (json files)
├── preferences.md   ← or any config file your tool needs
└── .env
\`\`\`

## What's already built
- [Feature 1]
- [Feature 2]

## Known constraints
- [Any gotchas Claude should know about]
```

---

## Step 2: Your kickoff prompt

Use this structure for the very first message in a new project:

```
I want to build a [what it is] for [who/what purpose].

It should:
- [Core thing it does]
- [Second thing]
- [Third thing]

Technical constraints:
- Local only, runs on my machine
- Python Flask backend on port 5000
- Vanilla JS frontend, no framework
- Flat JSON files for storage
- Anthropic API for [AI feature]
- [External API] for [purpose]

Start by creating the project structure and a working shell:
- server.py with Flask skeleton and /ping health check
- static/index.html with the basic app layout
- static/app.js with state and navigation
- static/style.css with clean base styles
- .env.example with placeholder keys
- CLAUDE.md documenting the project

Don't build the full features yet — just the skeleton that runs.
```

---

## Step 3: Add features one at a time

After the skeleton runs, add features in separate conversations. Each feature gets its own message thread. Keep each one focused:

```
Add [Feature Name] to the grocery agent.

What it needs to do:
- [Specific behavior 1]
- [Specific behavior 2]

Files to change:
- server.py: add [endpoint]
- app.js: add [function]
- style.css: add [component styles]

Don't change anything outside these files.
```

**Commit after every feature.** This gives you clean rollback points and keeps Claude's diff small on the next change.

---

## Step 4: Create a context.md for session continuity

Claude sessions have limited memory. A `context.md` file at the project root lets you paste the current project state into any new conversation instantly.

**What to put in it:**
- What the project does (2–3 sentences)
- How to run it
- Current file structure
- All server endpoints with their purpose
- Key JS functions
- Data shapes (what your JSON looks like)
- Features implemented so far
- Known constraints

Update it after each major feature. When starting a new Claude session, paste the contents of context.md in your first message.

**Example opener for a new session:**
```
Here's the current state of my project:

[paste context.md contents]

Today I want to [new feature or fix].
```

---

## Step 5: Give Claude a design file

Instead of describing your visual style in words, create an HTML design system document. Claude can read it and apply it precisely.

A good design file includes:
- Color palette with hex values and variable names
- Typography rules (which fonts, weights, when to use each)
- Component examples (buttons, cards, inputs, badges) with live HTML/CSS
- Motion and interaction patterns
- A clear naming convention for CSS custom properties

Then in your session:
```
I have a new design file that I want the app updated to use, see style-guide-v3.html
```

Claude will read the file and rewrite your CSS to match. This is far more reliable than describing colors and spacing in prose.

---

## Step 6: Structured config files beat raw text

For anything your app needs to read as preferences or config, use JSON instead of markdown. Markdown is hard to parse reliably. JSON is:
- Readable and editable by Claude
- Easy to serve from Flask
- Easy to update from a UI you build yourself

**Pattern:**
```python
PREFS_PATH = os.path.join(os.path.dirname(__file__), 'data', 'prefs.json')

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
```

Then build a UI panel to edit those prefs in the browser instead of editing JSON directly.

---

## What worked well

**Be specific about file scope.** Tell Claude exactly which files to touch. "Don't change anything outside server.py and app.js" prevents surprise rewrites.

**Commit and push after every feature.** You get clean rollback points and can say "revert to the last commit" if something breaks.

**Show Claude the full file before editing.** Claude will ask to read files before changing them. Let it. It catches conflicts and avoids overwriting things you didn't mean to change.

**Feature-by-feature > big bang.** A working skeleton on day one, then one feature per session, is faster than trying to build everything at once. Each session is focused, the diff is small, and it's easy to course-correct.

**Tell Claude your constraints once, clearly.** Things like "never commit .env", "Flask debug mode restarts on file changes so restart after editing server.py", "use pycryptodome not pycrypto" — put these in CLAUDE.md and you'll never have to repeat them.

**Use the browser to test, not just the linter.** Claude can write code that type-checks and lints fine but has broken behavior in the actual UI. Always open the browser and click through the feature before committing.

---

## Starter file checklist

Before your first Claude session, have these ready:

- [ ] `CLAUDE.md` — project context (use template above)
- [ ] `.env` — credentials (never commit this)
- [ ] `.gitignore` — at minimum: `.env`, `*.pem`, `__pycache__/`, `*.pyc`
- [ ] `data/` directory — empty, for JSON storage files
- [ ] Any API keys or credentials from your external service

After your first session:
- [ ] `context.md` — shareable project summary, update after each feature
- [ ] First git commit with the skeleton running
