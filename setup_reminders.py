#!/usr/bin/env python3
"""
One-time setup: registers two tasks in Windows Task Scheduler.

  1. DinnerReminder   — reminder_agent.py       Mon–Fri at 3:30pm
  2. WeeklySummary    — weekly_summary_agent.py  Sundays  at 9:00am

Usage:
  python setup_reminders.py

Requires: Run as a normal user (no admin needed for per-user tasks).
To remove: schtasks /Delete /TN "GroceryAgent\\DinnerReminder" /F
           schtasks /Delete /TN "GroceryAgent\\WeeklySummary" /F
To test:   python reminder_agent.py --test
           python weekly_summary_agent.py --test
"""
import os, sys, subprocess, textwrap, datetime

SCRIPT_DIR     = os.path.dirname(os.path.abspath(__file__))
PYTHON_EXE     = sys.executable

today = datetime.date.today()

# ── Dinner reminder: next Monday ──────────────────────────────────────────────
REMINDER_PATH  = os.path.join(SCRIPT_DIR, 'reminder_agent.py')
REMINDER_TASK  = r'GroceryAgent\DinnerReminder'
days_to_mon    = (7 - today.weekday()) % 7 or 7
next_monday    = today + datetime.timedelta(days=days_to_mon)
REMINDER_START = f"{next_monday.isoformat()}T15:30:00"

REMINDER_XML = textwrap.dedent(f"""\
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Grocery Agent — sends dinner reminder email Mon-Fri at 3:30pm</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>{REMINDER_START}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByWeek>
        <WeeksInterval>1</WeeksInterval>
        <DaysOfWeek>
          <Monday />
          <Tuesday />
          <Wednesday />
          <Thursday />
          <Friday />
        </DaysOfWeek>
      </ScheduleByWeek>
    </CalendarTrigger>
  </Triggers>
  <Actions Context="Author">
    <Exec>
      <Command>{PYTHON_EXE}</Command>
      <Arguments>"{REMINDER_PATH}"</Arguments>
      <WorkingDirectory>{SCRIPT_DIR}</WorkingDirectory>
    </Exec>
  </Actions>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
  </Settings>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
</Task>
""")

# ── Weekly summary: next Sunday ───────────────────────────────────────────────
SUMMARY_PATH  = os.path.join(SCRIPT_DIR, 'weekly_summary_agent.py')
SUMMARY_TASK  = r'GroceryAgent\WeeklySummary'
days_to_sun   = (6 - today.weekday()) % 7 or 7
next_sunday   = today + datetime.timedelta(days=days_to_sun)
SUMMARY_START = f"{next_sunday.isoformat()}T09:00:00"

SUMMARY_XML = textwrap.dedent(f"""\
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Grocery Agent — sends weekly meal plan + calendar summary email on Sundays at 9am</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>{SUMMARY_START}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByWeek>
        <WeeksInterval>1</WeeksInterval>
        <DaysOfWeek>
          <Sunday />
        </DaysOfWeek>
      </ScheduleByWeek>
    </CalendarTrigger>
  </Triggers>
  <Actions Context="Author">
    <Exec>
      <Command>{PYTHON_EXE}</Command>
      <Arguments>"{SUMMARY_PATH}"</Arguments>
      <WorkingDirectory>{SCRIPT_DIR}</WorkingDirectory>
    </Exec>
  </Actions>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
  </Settings>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
</Task>
""")


def _register_task(task_name, xml_str, xml_path):
    with open(xml_path, 'w', encoding='utf-16') as f:
        f.write(xml_str)
    result = subprocess.run(
        ['schtasks', '/Create', '/F', '/TN', task_name, '/XML', xml_path],
        capture_output=True, text=True
    )
    os.remove(xml_path)
    return result


def main():
    xml_path = os.path.join(SCRIPT_DIR, '_task_def.xml')

    # Dinner reminder
    r = _register_task(REMINDER_TASK, REMINDER_XML, xml_path)
    if r.returncode == 0:
        print(f"[OK] Dinner reminders scheduled - fires Mon-Fri at 3:30pm starting {next_monday}.")
        print(f"  To verify : schtasks /Query /TN \"{REMINDER_TASK}\"")
        print(f"  To test   : python reminder_agent.py --test")
    else:
        print("[FAIL] Failed to create DinnerReminder task:")
        print(r.stderr or r.stdout)

    # Weekly summary
    r = _register_task(SUMMARY_TASK, SUMMARY_XML, xml_path)
    if r.returncode == 0:
        print(f"[OK] Weekly summary scheduled - fires Sundays at 9:00am starting {next_sunday}.")
        print(f"  To verify : schtasks /Query /TN \"{SUMMARY_TASK}\"")
        print(f"  To test   : python weekly_summary_agent.py --test")
    else:
        print("[FAIL] Failed to create WeeklySummary task:")
        print(r.stderr or r.stdout)

    if not os.getenv('GMAIL_APP_PASSWORD', ''):
        print()
        print("Tip: GMAIL_APP_PASSWORD not found in .env — emails won't send until it's set.")
        print("     See reminder_agent.py for setup instructions.")


if __name__ == '__main__':
    main()
