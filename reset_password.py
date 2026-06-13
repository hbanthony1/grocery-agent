#!/usr/bin/env python3
"""
Emergency password reset — runs without starting the server.

Usage:
  python reset_password.py              # interactive: pick username, enter new password
  python reset_password.py <username>   # skip username prompt
  python reset_password.py --list       # show all registered usernames
"""
import sys, json, os, getpass
from datetime import datetime

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
USERS_PATH = os.path.join(SCRIPT_DIR, 'data', 'users.json')


def _load():
    try:
        with open(USERS_PATH, encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {'users': {}}


def _save(data):
    os.makedirs(os.path.dirname(USERS_PATH), exist_ok=True)
    with open(USERS_PATH, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)


def main():
    args = sys.argv[1:]

    if '--list' in args:
        data  = _load()
        users = data.get('users', {})
        if not users:
            print('No accounts found.')
        else:
            print('Registered accounts:')
            for u, info in users.items():
                print(f'  {u}  (created {info.get("created_at", "unknown")})')
        return

    data = _load()

    if args:
        username = args[0].strip().lower()
    else:
        existing = list(data.get('users', {}).keys())
        if existing:
            print('Registered accounts: ' + ', '.join(existing))
        username = input('Username to reset (or new username to create): ').strip().lower()

    if not username:
        print('No username entered. Aborted.')
        sys.exit(1)

    is_new = username not in data.get('users', {})
    if is_new:
        confirm = input(f"'{username}' not found — create new account? [y/N] ").strip().lower()
        if confirm != 'y':
            sys.exit(1)

    pw = getpass.getpass(f"New password for '{username}': ")
    if len(pw) < 6:
        print('Password must be at least 6 characters.')
        sys.exit(1)
    pw2 = getpass.getpass('Confirm password: ')
    if pw != pw2:
        print("Passwords don't match.")
        sys.exit(1)

    from werkzeug.security import generate_password_hash
    existing_entry = data.setdefault('users', {}).get(username, {})
    data['users'][username] = {
        **existing_entry,
        'password':   generate_password_hash(pw),
        'created_at': existing_entry.get('created_at', datetime.now().isoformat()),
    }
    _save(data)
    action = 'created' if is_new else 'updated'
    print(f"Password {action} for '{username}'. You can now log in at http://localhost:5000/login")


if __name__ == '__main__':
    main()
