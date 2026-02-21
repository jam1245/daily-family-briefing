# Daily Family Briefing

A GitHub Actions workflow that emails **John and Sutton Mataya** every morning at **6:30 AM ET** with:

- 🚨 Urgent items — deadlines, decisions, school acceptances, RSVPs
- ⚠️ Logistics conflicts — when two kids need rides at the same time
- 📚 Sutton-unavailable alerts — UMD class nights and other commitments flagged so John knows to cover
- 📅 Full day + 7-day calendar view across all family calendars

Calendars monitored: John · Sutton · Family · Arlington Public Schools · All-Stars Baseball · Kids Basketball · Cubs Sports

---

## First-Time Setup (~10 minutes)

### 1. Clone this repo to your Mac

```bash
cd ~/GitHub
git clone https://github.com/YOUR_USERNAME/daily-family-briefing.git
cd daily-family-briefing
```

### 2. Run the setup wizard

```bash
python3 setup.py
```

This will:
- Install Python dependencies
- Walk you through getting a Google API `credentials.json` (one-time, ~3 min)
- Open a browser to authorise Google Calendar + Gmail
- Print the two base64-encoded values you need to add as GitHub Secrets

### 3. Add GitHub Secrets

In your repo on GitHub: **Settings → Secrets and variables → Actions → New repository secret**

| Secret name | Value |
|---|---|
| `GOOGLE_TOKEN_JSON` | Printed by setup.py |
| `GOOGLE_CREDENTIALS_JSON` | Printed by setup.py |

### 4. Push and you're done

GitHub Actions runs the workflow every morning at 6:30 AM ET automatically.
To trigger a test run immediately: **Actions → Daily Family Briefing → Run workflow**

---

## Files

| File | Purpose |
|---|---|
| `daily_briefing.py` | Main script — fetches calendars, builds + sends email |
| `setup.py` | One-time local auth wizard |
| `requirements.txt` | Python dependencies |
| `.github/workflows/daily-briefing.yml` | GitHub Actions schedule |
| `.gitignore` | Keeps credentials out of git |
| `credentials.json` | *(You create, never committed)* Google OAuth client |
| `token.json` | *(Auto-created, never committed)* OAuth token |

---

## Adjusting the Schedule

The workflow runs at `30 11 * * *` UTC, which equals:

| Season | UTC time | ET time |
|---|---|---|
| Nov – Mar (EST) | 11:30 AM | **6:30 AM** ✅ |
| Mar – Nov (EDT) | 10:30 AM | **6:30 AM** ✅ |

To handle Daylight Saving automatically, update `.github/workflows/daily-briefing.yml`:

```yaml
# Winter (EST): runs at 11:30 UTC = 6:30 AM ET
- cron: "30 11 * * *"

# Summer (EDT): change to 10:30 UTC = 6:30 AM ET
- cron: "30 10 * * *"
```

Or keep one cron and accept it shifts by an hour seasonally — totally fine for a family briefing.

---

## Updating the Script

Edit `daily_briefing.py` and push a commit. The next run picks up your changes automatically.

Common tweaks at the top of the file:
- `RECIPIENTS` — who gets the email
- `CALENDARS` — add or remove calendars by ID
- `DECISION_KEYWORDS` — words that trigger urgent alerts
- `SUTTON_UNAVAILABLE_KEYWORDS` — events that flag John to cover logistics

---

## Re-authorising (if token expires)

Google refresh tokens for Desktop app OAuth clients don't typically expire, but if they do:

```bash
rm token.json
python3 setup.py
```

Then update the `GOOGLE_TOKEN_JSON` GitHub Secret with the new value printed by setup.py.
