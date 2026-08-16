#!/usr/bin/env python3
"""
Weekday dinner reminder — run daily at 3:30pm via Windows Task Scheduler.

Setup (one-time):
  1. Add to .env:
       GMAIL_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx   (16-char Gmail App Password)
       GMAIL_FROM=hbanthony1@gmail.com
       GMAIL_TO=hbanthony1@gmail.com
  2. Run: python setup_reminders.py

  Gmail App Password steps:
  - Go to myaccount.google.com/security
  - Enable 2-Step Verification (if not already on)
  - Search "App passwords", create one named "Grocery Agent"
  - Paste the 16-char password into .env as GMAIL_APP_PASSWORD
"""
import os, json, smtplib, datetime, sys
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from dotenv import load_dotenv

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def _user_data_dir():
    """Return the data directory for the first registered user, falling back to data/."""
    users_path = os.path.join(SCRIPT_DIR, 'data', 'users.json')
    try:
        with open(users_path, encoding='utf-8') as f:
            users = json.load(f).get('users', {})
        if users:
            first_user = next(iter(users))
            user_dir = os.path.join(SCRIPT_DIR, 'data', 'users', first_user)
            if os.path.isdir(user_dir):
                return user_dir
    except Exception:
        pass
    return os.path.join(SCRIPT_DIR, 'data')


_DATA_DIR     = _user_data_dir()
SCHEDULE_PATH = os.path.join(_DATA_DIR, 'meal_schedule.json')
RECIPES_PATH  = os.path.join(_DATA_DIR, 'recipes.json')

load_dotenv(os.path.join(SCRIPT_DIR, '.env'))


def _load_json(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _get_recipe(meal_name: str):
    """Return the recipe dict for meal_name, or None."""
    recipes = _load_json(RECIPES_PATH) or []
    return next(
        (r for r in recipes if r.get('name', '').lower() == meal_name.lower()),
        None
    )


def _ing_text(i) -> str:
    """Return readable string from either a plain string or {name, amount} dict."""
    if isinstance(i, dict):
        return ' '.join(p for p in [i.get('name', ''), i.get('amount', '')] if p)
    return str(i)


def _build_email(meal_name: str, today_name: str, recipe) -> tuple[str, str]:
    """Return (plain_text, html) for the reminder email."""
    raw_ingredients = recipe.get('ingredients', []) if recipe else []
    ingredients = [_ing_text(i) for i in raw_ingredients]
    steps       = recipe.get('steps', [])       if recipe else []
    notes       = recipe.get('notes', '')        if recipe else ''

    # --- plain text ---
    lines = [
        f"Hi! Heads up — dinner is at 5:30pm.",
        f"",
        f"Tonight ({today_name}): {meal_name}",
    ]
    if notes:
        lines += [f"Note: {notes}", ""]
    if ingredients:
        lines += ["INGREDIENTS", "----------"] + [f"  • {i}" for i in ingredients] + [""]
    if steps:
        lines += ["STEPS", "-----"] + [f"  {n+1}. {s}" for n, s in enumerate(steps)] + [""]
    lines += ["You've got 2 hours. Start prepping now!", "", "— Grocery Agent"]
    plain = "\n".join(lines)

    # --- html ---
    def esc(s): return s.replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')

    ingr_html = "".join(f"<li>{esc(i)}</li>" for i in ingredients)
    steps_html = "".join(f"<li>{esc(s)}</li>" for s in steps)
    notes_html = f'<p style="color:#666;font-style:italic">{esc(notes)}</p>' if notes else ''

    recipe_section = ""
    if ingredients or steps:
        recipe_section = f"""
        <hr style="border:none;border-top:1px solid #e0e0e0;margin:24px 0">
        <h2 style="font-size:16px;color:#333;margin:0 0 12px">Recipe</h2>
        {notes_html}
        {'<h3 style="font-size:14px;color:#555;margin:16px 0 8px">Ingredients</h3><ul style="margin:0;padding-left:20px;line-height:1.8">' + ingr_html + '</ul>' if ingredients else ''}
        {'<h3 style="font-size:14px;color:#555;margin:16px 0 8px">Steps</h3><ol style="margin:0;padding-left:20px;line-height:1.9">' + steps_html + '</ol>' if steps else ''}
        """

    html = f"""<!DOCTYPE html>
<html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#222">
  <p style="margin:0 0 4px;color:#888;font-size:13px">{esc(today_name)}</p>
  <h1 style="font-size:22px;margin:0 0 8px">Dinner tonight: {esc(meal_name)}</h1>
  <p style="margin:0 0 20px;color:#555">Dinner is at 5:30 pm — you've got 2 hours. Start prepping now!</p>
  {recipe_section}
  <p style="margin:32px 0 0;font-size:12px;color:#aaa">— Grocery Agent</p>
</body></html>"""

    return plain, html


def _resolve_recipients() -> list[str]:
    prefs_path = os.path.join(_DATA_DIR, 'prefs.json')
    try:
        with open(prefs_path, encoding='utf-8') as f:
            p = json.load(f)
        emails = p.get('emails') or []
        if not emails and p.get('email'):
            emails = [p['email']]
    except Exception:
        emails = []
    if not emails:
        env_val = os.getenv('GMAIL_TO', 'hbanthony1@gmail.com')
        emails = [e.strip() for e in env_val.split(',') if e.strip()]
    return emails


def send_reminder(meal_name: str) -> None:
    recipients = _resolve_recipients()
    from_email = os.getenv('GMAIL_FROM', recipients[0])
    app_pw     = os.getenv('GMAIL_APP_PASSWORD', '')
    if not app_pw:
        raise ValueError('GMAIL_APP_PASSWORD not set in .env')

    today_name = datetime.date.today().strftime('%A, %B %-d') if os.name != 'nt' else \
                 datetime.date.today().strftime('%A, %B %d').replace(' 0', ' ')
    recipe     = _get_recipe(meal_name)
    plain, html = _build_email(meal_name, today_name, recipe)

    msg             = MIMEMultipart('alternative')
    msg['From']     = from_email
    msg['To']       = ', '.join(recipients)
    msg['Subject']  = f"Dinner tonight: {meal_name}"
    msg.attach(MIMEText(plain, 'plain'))
    msg.attach(MIMEText(html,  'html'))

    with smtplib.SMTP_SSL('smtp.gmail.com', 465) as server:
        server.login(from_email, app_pw)
        server.send_message(msg)


def main():
    test_mode = '--test' in sys.argv
    today     = datetime.date.today().isoformat()
    schedule  = _load_json(SCHEDULE_PATH)
    if not schedule:
        print(f"[{today}] No meal schedule found — run a planning session first.")
        return

    if test_mode:
        # Send the next unreminded meal regardless of date
        entry = next((e for e in schedule if not e.get('reminded')), None)
        if not entry:
            print(f"[TEST] All meals already reminded — reset 'reminded' flags in meal_schedule.json to retest.")
            return
        print(f"[TEST] Sending test reminder for {entry['day']} ({entry['date']}): {entry['meal']}")
    else:
        entry = next((e for e in schedule if e.get('date') == today), None)
        if not entry:
            print(f"[{today}] No dinner scheduled for today.")
            return
        if entry.get('reminded'):
            print(f"[{today}] Already sent reminder for {entry['meal']}.")
            return

    meal = entry['meal']
    try:
        send_reminder(meal)
        if not test_mode:
            entry['reminded'] = True
            with open(SCHEDULE_PATH, 'w', encoding='utf-8') as f:
                json.dump(schedule, f, indent=2)
        print(f"[{'TEST' if test_mode else today}] Reminder sent: {meal}")
    except Exception as e:
        print(f"[{'TEST' if test_mode else today}] Failed to send reminder: {e}")
        raise


if __name__ == '__main__':
    main()
