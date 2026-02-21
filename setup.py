#!/usr/bin/env python3
"""
One-time local setup for Daily Family Briefing.
Run this on your Mac to authenticate with Google, then follow
the printed instructions to add the token as a GitHub Secret.
"""

import subprocess, sys, json, base64
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
SCOPES = [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/gmail.send",
]

def install_deps():
    print("📦 Installing dependencies...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "-r",
                           str(SCRIPT_DIR / "requirements.txt")])
    print("   ✅ Done\n")

def check_credentials():
    creds_file = SCRIPT_DIR / "credentials.json"
    if not creds_file.exists():
        print("=" * 62)
        print("STEP 1 — Download your Google API credentials")
        print("=" * 62)
        print("""
  1. Go to  https://console.cloud.google.com/
  2. Create a project (e.g. 'Family Briefing')
  3. APIs & Services → Enable APIs → enable:
       • Google Calendar API
       • Gmail API
  4. APIs & Services → Credentials → + Create Credentials
       → OAuth client ID → Desktop app → name it anything
  5. Download JSON → rename to credentials.json
  6. Move credentials.json into this folder:
""")
        print(f"     {creds_file}\n")
        print("Then run this setup script again.\n")
        return False
    print("✅ credentials.json found\n")
    return True

def authenticate():
    from google_auth_oauthlib.flow import InstalledAppFlow

    token_file  = SCRIPT_DIR / "token.json"
    creds_file  = SCRIPT_DIR / "credentials.json"

    print("=" * 62)
    print("STEP 2 — Authorise Google access")
    print("=" * 62)
    print("\nA browser window will open — sign in as johnmataya@gmail.com")
    print("and grant Calendar (read) + Gmail (send) access.\n")

    flow  = InstalledAppFlow.from_client_secrets_file(str(creds_file), SCOPES)
    creds = flow.run_local_server(port=0)
    token_file.write_text(creds.to_json())
    print(f"\n✅ Token saved locally to {token_file}\n")
    return creds

def export_for_github(creds):
    token_file  = SCRIPT_DIR / "token.json"
    creds_file  = SCRIPT_DIR / "credentials.json"

    token_b64 = base64.b64encode(token_file.read_bytes()).decode()
    creds_b64 = base64.b64encode(creds_file.read_bytes()).decode()

    print("=" * 62)
    print("STEP 3 — Add secrets to GitHub")
    print("=" * 62)
    print("""
Go to your GitHub repo → Settings → Secrets and variables
→ Actions → New repository secret

Add these two secrets:

─────────────────────────────────────────────────────────
Secret name:   GOOGLE_TOKEN_JSON
Secret value:
""")
    print(token_b64)
    print("""
─────────────────────────────────────────────────────────
Secret name:   GOOGLE_CREDENTIALS_JSON
Secret value:
""")
    print(creds_b64)
    print("""
─────────────────────────────────────────────────────────

Both values are base64-encoded so they're safe to paste
directly into GitHub's secret field.

Keep credentials.json and token.json on your Mac as a
backup, but never commit them — they're in .gitignore.
""")

def test_run():
    answer = input("Send a test email right now? (y/n): ").strip().lower()
    if answer == "y":
        result = subprocess.run([sys.executable, str(SCRIPT_DIR / "daily_briefing.py")])
        if result.returncode == 0:
            print("\n✅ Test email sent! Check both inboxes.\n")
        else:
            print("\n❌ Something went wrong — check the output above.\n")

def main():
    print("\n📅  Daily Family Briefing — Setup\n")
    install_deps()
    if not check_credentials():
        sys.exit(0)
    creds = authenticate()
    export_for_github(creds)
    test_run()
    print("=" * 62)
    print("✅  Setup complete!")
    print("=" * 62)
    print("""
Next steps:
  1. Add the two GitHub Secrets shown above
  2. Push this repo to GitHub (see README for the commands)
  3. GitHub will email both of you every morning at 6:30 AM

To trigger a test run in GitHub Actions at any time:
  → Repo → Actions → Daily Family Briefing → Run workflow
""")

if __name__ == "__main__":
    main()
