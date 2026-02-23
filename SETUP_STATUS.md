# Daily Family Briefing — Setup Status

## What This Project Does
A GitHub Actions workflow that emails **John and Sutton** every morning at **6:30 AM ET** with:
- Today's full schedule + 7-day week view across all family calendars
- Logistics conflict alerts (two kids needing rides at the same time)
- Sutton-unavailable flags (UMD class Thursdays 8–10 PM → John covers evening)
- Deadline/decision items surfaced at the top (school acceptances, RSVPs, etc.)

Runs in **GitHub's cloud** — Mac does not need to be on or awake.

---

## Repo Location
```
~/GitHub/daily-family-briefing/
```

### File Structure
```
daily-family-briefing/
├── .github/
│   └── workflows/
│       └── daily-briefing.yml   ← GitHub Actions schedule (6:30 AM ET daily)
├── daily_briefing.py            ← Main script (fetches calendars, builds + sends email)
├── setup.py                     ← One-time local auth wizard
├── requirements.txt             ← Python dependencies
├── .gitignore                   ← Keeps credentials.json + token.json out of git
└── README.md                    ← Full reference docs
```

---

## What's Done ✅

- [x] All code written and committed to local git repo (`main` branch, 1 commit)
- [x] `.gitignore` configured — `credentials.json` and `token.json` will never be committed
- [x] GitHub Actions workflow file ready at `.github/workflows/daily-briefing.yml`
- [x] Script reads credentials from **environment variables** (GitHub Secrets) in CI, or local files when run locally
- [x] Homebrew installed on Mac

---

## What Still Needs to Be Done ⏳

### Step 1 — Add Homebrew to PATH
Homebrew was just installed but the PATH hasn't been updated in the current shell yet.
Run these three lines first:
```bash
echo >> /Users/jam/.zprofile
echo 'eval "$(/opt/homebrew/bin/brew shellenv zsh)"' >> /Users/jam/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv zsh)"
```

### Step 2 — Install GitHub CLI and authenticate
```bash
brew install gh
gh auth login
```
When prompted by `gh auth login`:
- Choose **GitHub.com**
- Choose **HTTPS**
- Choose **Login with a web browser**

### Step 3 — Push repo to GitHub
You should still be in the right folder. If not: `cd ~/GitHub/daily-family-briefing`
```bash
gh repo create daily-family-briefing --private --source=. --remote=origin --push
```

### Step 4 — Run the local Google auth wizard
```bash
python3 ~/GitHub/daily-family-briefing/setup.py
```
This will:
1. Install Python dependencies (`google-api-python-client`, `pytz`, etc.)
2. Prompt you to download a `credentials.json` from Google Cloud Console (instructions printed)
3. Open a browser → sign in with your Google account → grant Calendar + Gmail access
4. Print two base64-encoded values to copy into GitHub Secrets (next step)

### Step 5 — Add Google credentials as GitHub Secrets
Go to: `https://github.com/jam/daily-family-briefing/settings/secrets/actions`
*(adjust username if different)*

Add two secrets:
| Secret Name | Value |
|---|---|
| `GOOGLE_TOKEN_JSON` | Printed by setup.py (long base64 string) |
| `GOOGLE_CREDENTIALS_JSON` | Printed by setup.py (long base64 string) |

### Step 6 — Test it
In GitHub: **Actions → Daily Family Briefing → Run workflow**
Should send a test email to both john + sutton within ~30 seconds.

---

## Google Cloud Console Setup (needed for Step 4)
When setup.py asks for `credentials.json`:
1. Go to **https://console.cloud.google.com/**
2. Create a new project (name it anything, e.g. "Family Briefing")
3. **APIs & Services → Enable APIs** → enable:
   - Google Calendar API
   - Gmail API
4. **APIs & Services → Credentials → + Create Credentials → OAuth client ID**
   - Application type: **Desktop app**
   - Name: anything
5. Click **Download JSON**
6. Rename file to `credentials.json`
7. Move it into `~/GitHub/daily-family-briefing/credentials.json`

---

## Calendars Being Monitored
| Calendar | ID |
|---|---|
| John | Set via `JOHN_CALENDAR_ID` GitHub Secret |
| Sutton | Set via `SUTTON_CALENDAR_ID` GitHub Secret |
| Family | family15193680876382494899@group.calendar.google.com |
| Arlington Public Schools | 3r4onhtersmi5hjrmuhknrrls1gqe0vi@import.calendar.google.com |
| All-Stars Baseball | 1iuoufcggph8urbobsgnfikspcmvcc5b@import.calendar.google.com |
| Kids Basketball | kmho7vounu05o45fral93kqi14@group.calendar.google.com |
| Cubs Sports | 935rsafqkfciefs72071t9a7dn1v8rv3@import.calendar.google.com |

---

## Schedule
- **Cron:** `30 11 * * *` UTC = **6:30 AM EST** (Nov–Mar)
- When Daylight Saving starts in March, change to `30 10 * * *` UTC to keep it at 6:30 AM EDT
- Can also trigger manually anytime from the GitHub Actions tab

---

## Notes
- `credentials.json` and `token.json` are in `.gitignore` — they will never be pushed to GitHub
- The Google OAuth token auto-refreshes; you shouldn't need to re-authenticate
- To change anything (recipients, calendars, formatting): edit `daily_briefing.py` and push a commit
