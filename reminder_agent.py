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

SCRIPT_DIR     = os.path.dirname(os.path.abspath(__file__))
SCHEDULE_PATH  = os.path.join(SCRIPT_DIR, 'data', 'meal_schedule.json')
RECIPES_PATH   = os.path.join(SCRIPT_DIR, 'data', 'recipes.json')

load_dotenv(os.path.join(SCRIPT_DIR, '.env'))


def _load_json(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _get_prep_hint(meal_name: str) -> str:
    """Pull 1-2 useful prep steps from the recipe book."""
    recipes = _load_json(RECIPES_PATH) or []
    recipe  = next(
        (r for r in recipes if r.get('name', '').lower() == meal_name.lower()),
        None
    )
    if not recipe:
        return ''
    steps = recipe.get('steps') or []
    # Surface the first step that mentions defrost, preheat, marinate, or thaw
    keywords = ('defrost', 'thaw', 'preheat', 'marinate', 'soak', 'boil', 'cook rice')
    prep_steps = [s for s in steps if any(k in s.lower() for k in keywords)]
    if prep_steps:
        return f"Prep tip: {prep_steps[0]}"
    # Fall back to cook time from notes
    notes = recipe.get('notes', '')
    if notes:
        return f"Recipe note: {notes[:120]}"
    return ''


def send_reminder(meal_name: str) -> None:
    to_email   = os.getenv('GMAIL_TO', 'hbanthony1@gmail.com')
    from_email = os.getenv('GMAIL_FROM', to_email)
    app_pw     = os.getenv('GMAIL_APP_PASSWORD', '')
    if not app_pw:
        raise ValueError('GMAIL_APP_PASSWORD not set in .env')

    prep_hint = _get_prep_hint(meal_name)
    today_name = datetime.date.today().strftime('%A, %B %-d') if os.name != 'nt' else \
                 datetime.date.today().strftime('%A, %B %d').replace(' 0', ' ')

    body = f"""Hi! Heads up — dinner is at 5:30pm.

Tonight ({today_name}): {meal_name}
{(prep_hint + chr(10)) if prep_hint else ''}
You've got 2 hours. Start prepping now!

— Grocery Agent"""

    msg             = MIMEMultipart()
    msg['From']     = from_email
    msg['To']       = to_email
    msg['Subject']  = f"Dinner tonight: {meal_name}"
    msg.attach(MIMEText(body.strip(), 'plain'))

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
