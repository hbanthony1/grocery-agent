#!/usr/bin/env python3
"""
Sunday weekly summary email — run Sunday mornings via Windows Task Scheduler.

Sends one email with:
  - This week's planned dinners (from meal_schedule.json)
  - Calendar events for the week (if Google Calendar is connected)

Setup: python setup_reminders.py  (registers both this and the dinner reminder)
Test:  python weekly_summary_agent.py --test
"""
import os, json, smtplib, datetime, sys, html
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from zoneinfo import ZoneInfo
from dotenv import load_dotenv

SCRIPT_DIR    = os.path.dirname(os.path.abspath(__file__))
SCHEDULE_PATH = os.path.join(SCRIPT_DIR, 'data', 'meal_schedule.json')
PREFS_PATH    = os.path.join(SCRIPT_DIR, 'data', 'prefs.json')
TOKEN_PATH    = os.path.join(SCRIPT_DIR, 'data', 'google_token.json')

load_dotenv(os.path.join(SCRIPT_DIR, '.env'))

try:
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request as GRequest
    from googleapiclient.discovery import build as gcal_build
    _GCAL_AVAILABLE = True
except ImportError:
    _GCAL_AVAILABLE = False

GOOGLE_SCOPES = ['https://www.googleapis.com/auth/calendar.readonly']
DAYS_ORDER    = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']


def _load_json(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _get_timezone():
    prefs = _load_json(PREFS_PATH) or {}
    tz_name = prefs.get('timezone') or 'America/Denver'
    try:
        return ZoneInfo(tz_name)
    except Exception:
        return ZoneInfo('America/Denver')


def _week_range_from_schedule(schedule):
    """Return (monday_date, sunday_date) for the week covered by the schedule."""
    dates = []
    for entry in (schedule or []):
        try:
            dates.append(datetime.date.fromisoformat(entry['date']))
        except Exception:
            pass
    if dates:
        monday = min(dates)
        # Ensure we start on Monday
        monday -= datetime.timedelta(days=monday.weekday())
        sunday = monday + datetime.timedelta(days=6)
        return monday, sunday
    return None, None


def _upcoming_week(tz):
    """Mon–Sun of the week that starts tomorrow (used on Sundays + fallback)."""
    today = datetime.datetime.now(tz).date()
    days_until_monday = (7 - today.weekday()) % 7 or 7
    monday = today + datetime.timedelta(days=days_until_monday)
    return monday, monday + datetime.timedelta(days=6)


def _load_google_creds():
    if not _GCAL_AVAILABLE or not os.path.exists(TOKEN_PATH):
        return None
    try:
        with open(TOKEN_PATH) as f:
            return Credentials.from_authorized_user_info(json.load(f), GOOGLE_SCOPES)
    except Exception:
        return None


def _save_google_creds(creds):
    with open(TOKEN_PATH, 'w') as f:
        f.write(creds.to_json())


def _get_calendar_events(monday: datetime.date, sunday: datetime.date, tz):
    """Fetch events for the given Mon–Sun range. Returns {day_name: [events]} or None."""
    creds = _load_google_creds()
    if not creds:
        return None
    if creds.expired and creds.refresh_token:
        try:
            creds.refresh(GRequest())
            _save_google_creds(creds)
        except Exception:
            return None
    if not creds.valid:
        return None

    try:
        service  = gcal_build('calendar', 'v3', credentials=creds)
        time_min = datetime.datetime(monday.year, monday.month, monday.day, 0, 0, 0, tzinfo=tz).isoformat()
        time_max = datetime.datetime(sunday.year, sunday.month, sunday.day, 23, 59, 59, tzinfo=tz).isoformat()

        result = service.events().list(
            calendarId='primary',
            timeMin=time_min, timeMax=time_max,
            timeZone=tz.key,
            singleEvents=True, orderBy='startTime', maxResults=75
        ).execute()

        by_day = {d: [] for d in DAYS_ORDER}
        for event in result.get('items', []):
            start  = event.get('start', {})
            dt_str = start.get('dateTime') or start.get('date')
            if not dt_str:
                continue
            try:
                if start.get('dateTime'):
                    dt       = datetime.datetime.fromisoformat(dt_str).astimezone(tz)
                    h, m     = dt.hour, dt.minute
                    am_pm    = 'am' if h < 12 else 'pm'
                    h12      = h % 12 or 12
                    time_str = f"{h12}:{m:02d}{am_pm}" if m else f"{h12}{am_pm}"
                else:
                    dt       = datetime.datetime.fromisoformat(dt_str)
                    time_str = 'all day'
                day_name = dt.strftime('%A')
                if day_name in by_day:
                    by_day[day_name].append({'time': time_str, 'title': event.get('summary', 'Untitled')})
            except Exception:
                continue
        return by_day
    except Exception:
        return None


def _format_date_range(monday: datetime.date, sunday: datetime.date) -> str:
    if monday.month == sunday.month:
        return f"{monday.strftime('%B')} {monday.day}–{sunday.day}"
    return f"{monday.strftime('%b')} {monday.day} – {sunday.strftime('%b')} {sunday.day}"


def _build_email(schedule, calendar_events, monday, sunday):
    week_label = _format_date_range(monday, sunday)

    # Build meal lookup: {day_name: meal_name}
    meals_by_day = {}
    for entry in (schedule or []):
        meals_by_day[entry.get('day', '')] = entry.get('meal', '')

    # ── Plain-text ────────────────────────────────────────────────────────────
    lines = [f"Week of {week_label}\n"]

    lines.append("DINNERS")
    lines.append("─" * 40)
    if meals_by_day:
        for day in DAYS_ORDER:
            meal = meals_by_day.get(day)
            if meal:
                lines.append(f"{day:<12}{meal}")
    else:
        lines.append("No meal plan found — run a planning session first.")
    lines.append("")

    if calendar_events:
        has_events = any(calendar_events.get(d) for d in DAYS_ORDER)
        if has_events:
            lines.append("CALENDAR")
            lines.append("─" * 40)
            for day in DAYS_ORDER:
                evts = calendar_events.get(day, [])
                if evts:
                    first = True
                    for evt in evts:
                        prefix = f"{day:<12}" if first else " " * 12
                        lines.append(f"{prefix}{evt['time']:<10}{evt['title']}")
                        first = False
            lines.append("")

    lines.append("— Grocery Agent")
    plain = "\n".join(lines)

    # ── HTML ──────────────────────────────────────────────────────────────────
    def e(s):
        return html.escape(str(s))

    meal_rows = ""
    if meals_by_day:
        for day in DAYS_ORDER:
            meal = meals_by_day.get(day)
            if meal:
                meal_rows += f"""
        <tr>
          <td style="padding:9px 14px 9px 0;border-bottom:1px solid #f0f0f0;
                     font-weight:600;color:#555;white-space:nowrap;width:100px">{e(day)}</td>
          <td style="padding:9px 0;border-bottom:1px solid #f0f0f0;">{e(meal)}</td>
        </tr>"""
    else:
        meal_rows = """
        <tr><td colspan="2" style="padding:9px 0;color:#999;">
          No meal plan found — run a planning session first.</td></tr>"""

    cal_section = ""
    if calendar_events:
        has_events = any(calendar_events.get(d) for d in DAYS_ORDER)
        if has_events:
            cal_rows = ""
            for day in DAYS_ORDER:
                evts = calendar_events.get(day, [])
                if evts:
                    for i, evt in enumerate(evts):
                        day_cell = f'<td style="padding:8px 14px 8px 0;border-bottom:1px solid #f0f0f0;font-weight:600;color:#555;white-space:nowrap;width:100px;vertical-align:top">{e(day)}</td>' if i == 0 else '<td style="border-bottom:1px solid #f0f0f0;"></td>'
                        cal_rows += f"""
        <tr>
          {day_cell}
          <td style="padding:8px 12px 8px 0;border-bottom:1px solid #f0f0f0;
                     color:#777;white-space:nowrap;width:72px;vertical-align:top">{e(evt['time'])}</td>
          <td style="padding:8px 0;border-bottom:1px solid #f0f0f0;vertical-align:top">{e(evt['title'])}</td>
        </tr>"""

            cal_section = f"""
  <h2 style="font-size:13px;font-weight:700;text-transform:uppercase;
             letter-spacing:.07em;color:#888;margin:28px 0 10px">Calendar</h2>
  <table style="width:100%;border-collapse:collapse;font-size:15px">
    {cal_rows}
  </table>"""

    body = f"""<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
             max-width:580px;margin:0 auto;padding:28px 20px 40px;color:#1a1a1a;background:#fff">
  <p style="font-size:13px;color:#aaa;margin:0 0 20px 0">Week of {e(week_label)}</p>
  <h2 style="font-size:13px;font-weight:700;text-transform:uppercase;
             letter-spacing:.07em;color:#888;margin:0 0 10px">Dinners</h2>
  <table style="width:100%;border-collapse:collapse;font-size:15px">
    {meal_rows}
  </table>
  {cal_section}
  <p style="font-size:12px;color:#ccc;margin-top:36px">— Grocery Agent</p>
</body>
</html>"""

    return plain, body


def send_summary(schedule, calendar_events, monday, sunday) -> None:
    to_email   = os.getenv('GMAIL_TO', 'hbanthony1@gmail.com')
    from_email = os.getenv('GMAIL_FROM', to_email)
    app_pw     = os.getenv('GMAIL_APP_PASSWORD', '')
    if not app_pw:
        raise ValueError('GMAIL_APP_PASSWORD not set in .env')

    plain, html_body = _build_email(schedule, calendar_events, monday, sunday)
    week_label       = _format_date_range(monday, sunday)

    msg              = MIMEMultipart('alternative')
    msg['From']      = from_email
    msg['To']        = to_email
    msg['Subject']   = f"Week of {week_label}"
    msg.attach(MIMEText(plain, 'plain'))
    msg.attach(MIMEText(html_body, 'html'))

    with smtplib.SMTP_SSL('smtp.gmail.com', 465) as server:
        server.login(from_email, app_pw)
        server.send_message(msg)


def main():
    test_mode = '--test' in sys.argv
    tz        = _get_timezone()
    schedule  = _load_json(SCHEDULE_PATH) or []

    monday, sunday = _week_range_from_schedule(schedule)
    if monday is None:
        monday, sunday = _upcoming_week(tz)

    cal_events = _get_calendar_events(monday, sunday, tz)

    if test_mode:
        print(f"[TEST] Building weekly summary for {monday} – {sunday}")
        print(f"       Meals found : {len(schedule)}")
        print(f"       Calendar    : {'connected' if cal_events is not None else 'not connected'}")

    try:
        send_summary(schedule, cal_events, monday, sunday)
        tag = '[TEST]' if test_mode else f'[{datetime.date.today().isoformat()}]'
        print(f"{tag} Weekly summary sent for week of {monday}.")
    except Exception as e:
        print(f"[{'TEST' if test_mode else datetime.date.today().isoformat()}] Failed: {e}")
        raise


if __name__ == '__main__':
    main()
