# Family Calendar System

An automated family calendar assistant with two parts that work together:

1. **Daily Morning Email** — sent every day at 6:30 AM with your family's full schedule, logistics conflicts, and smart alerts
2. **Telegram Calendar Bot** — add events to Google Calendar by sending a screenshot, speaking out loud, or typing — from any phone, by any family member

Both run in the cloud. Your computer does not need to be on.

---

## Why We Built This

Modern family life generates a constant stream of scheduling information — but it arrives scattered across email, text messages, school apps, sports league newsletters, and group chats. Someone has to read all of it, decide what matters, and manually key it into a shared calendar. Then remember to tell everyone else. Then hope nobody double-booked Saturday.

The breaking point tends to look like this:

- A school sends a PDF with the semester's important dates — Bradford Awards Banquet, final exams, spring break, term transitions — buried in a long email with fifteen other announcements
- A sports coach texts the group chat: *"Spring hitting sessions start Wednesday, 6–7 PM, Corobus Sports, every Wednesday and Thursday through March 19"*
- A parent screenshots both, means to add them to the calendar, gets interrupted, and by Thursday nobody knows if practice is happening

The result is a family calendar that's always slightly out of date, a recurring "wait, did you add that?" conversation, and at least one missed event a month.

**This project automates the parts that shouldn't require human attention:**

- Every morning, one email summarizes the entire week across every calendar — no need to open Google Calendar, no need to mentally aggregate five sources
- When a scheduling email or text comes in, you screenshot it or read it aloud into Telegram — the AI extracts the event details, confirms them with you, and adds it to the calendar in seconds
- If two kids need to be in different places at the same time, the morning email flags it before the day starts, not while you're already in the car

The goal is a household where the calendar stays current without anyone having to sit down and maintain it.

---

## What It Does

### Morning Email
Every morning at 6:30 AM, everyone on the family list gets an email with:
- Today's full schedule + 7-day week view across all family calendars
- **Logistics conflict alerts** — two kids need to be in different places at the same time
- **Coverage alerts** — when one parent is unavailable for evening pickup/bedtime
- Clean, mobile-friendly HTML layout

### Telegram Bot
From any phone, in a shared group chat:
- 📸 **Send a screenshot** of a text, email, or flyer → bot reads it with AI and asks you to confirm
- 🎤 **Hold the mic and speak** → "Foster has soccer Saturday at 10am" → bot transcribes and confirms
- 💬 **Type it** → same result
- Events go to a designated calendar, the other parent is auto-invited
- **Duplicate detection** — warns you if the event looks like it's already on the calendar
- **Undo** — reply "undo" within 60 seconds to remove a just-added event
- **Cancellation detection** — "Practice Saturday is cancelled" → bot finds and offers to delete it
- **Edit before confirming** — tap ✏️ to fix anything before it's saved

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    DAILY EMAIL                          │
│  GitHub Actions (free)                                  │
│  Runs at 6:30 AM ET → Python script → Gmail API        │
│  Reads Google Calendar → Builds HTML → Sends email      │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                  TELEGRAM BOT                           │
│  Telegram (free) ←→ Cloudflare Worker (free)           │
│                         ↓                              │
│              Claude API (AI vision + text)             │
│              Google Speech-to-Text (voice)             │
│                         ↓                              │
│              Google Calendar API (create event)        │
└─────────────────────────────────────────────────────────┘
```

**Services used — all free or near-free at family scale:**

| Service | Purpose | Cost |
|---|---|---|
| GitHub Actions | Runs the morning email on a schedule | Free |
| Google Calendar API | Reads and writes calendar events | Free |
| Gmail API | Sends the morning email | Free |
| Google Speech-to-Text | Transcribes voice messages | ~$0.04/month |
| Cloudflare Workers | Hosts the Telegram bot webhook | Free |
| Telegram | Chat interface for the bot | Free |
| Anthropic Claude API | Reads screenshots, understands text | ~$0.10/month |

---

## What You'll Need Before Starting

Create free accounts at these services — it takes about 20 minutes total:

- [**GitHub**](https://github.com) — hosts the code and runs the daily email
- [**Google Cloud Console**](https://console.cloud.google.com) — Calendar, Gmail, and Speech-to-Text APIs
- [**Cloudflare**](https://cloudflare.com) — hosts the Telegram bot
- [**Telegram**](https://telegram.org) — the chat app your family uses to add events
- [**Anthropic**](https://console.anthropic.com) — Claude API for AI understanding of screenshots and text

---

## Part 1 — Daily Morning Email

### Step 1 · Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Click the project dropdown (top left) → **New Project** → name it `Family Briefing` → Create
3. Go to **APIs & Services → Library** and enable these three APIs:
   - **Google Calendar API**
   - **Gmail API**
   - **Cloud Speech-to-Text API**
4. Go to **APIs & Services → Credentials → + Create Credentials → OAuth client ID**
   - Application type: **Desktop app**
   - Name: anything (e.g. `Family Briefing`)
5. Click **Download JSON** → rename the file to `credentials.json`
6. Move `credentials.json` into your cloned repo folder

> **Note on the OAuth consent screen:** If prompted, set it to **External** and add your own Gmail address as a test user. You don't need to publish the app.

### Step 2 · Authorise Google on your computer

With `credentials.json` in the repo folder, run:

```bash
cd ~/path/to/daily-family-briefing
python3 setup.py
```

This will:
- Install Python dependencies automatically
- Open a browser → sign in with the Google account that owns your calendars
- Grant Calendar, Gmail, and Speech-to-Text access
- Print two long base64 strings: `GOOGLE_TOKEN_JSON` and `GOOGLE_CREDENTIALS_JSON`

**Save both values** — you'll need them in the next step and again for the Telegram bot.

### Step 3 · Push to GitHub

```bash
# Create a private GitHub repo and push
gh repo create family-briefing --private --source=. --remote=origin --push
```

If you don't have the GitHub CLI: [github.com/new](https://github.com/new) → create the repo → follow the push instructions.

### Step 4 · Add GitHub Secrets

In your repo on GitHub: **Settings → Secrets and variables → Actions → New repository secret**

Add all of these:

| Secret name | Where to get it |
|---|---|
| `GOOGLE_TOKEN_JSON` | Printed by `setup.py` |
| `GOOGLE_CREDENTIALS_JSON` | Printed by `setup.py` |
| `BRIEFING_SENDER` | Gmail address that sends the email (your Google account) |
| `BRIEFING_RECIPIENTS` | Comma-separated addresses that receive it |
| `JOHN_CALENDAR_ID` | Google Calendar ID — usually the Gmail address of that person |
| `SUTTON_CALENDAR_ID` | Same for the other parent/partner |

> **Finding a Calendar ID:** Open [calendar.google.com](https://calendar.google.com) → click the three dots next to a calendar → Settings → scroll down to **Integrate calendar** → copy the Calendar ID. For personal calendars it's usually just the Gmail address.

### Step 5 · Test it

Go to your repo → **Actions → Daily Family Briefing → Run workflow**

Check your inbox within 30 seconds. If it works, GitHub will run it every morning at 6:30 AM ET automatically — no computer required.

### Customising the email

Edit `daily_briefing.py` and push a commit. Changes take effect on the next run.

**Key things to customise:**

```python
# Who gets the email
RECIPIENTS = [r.strip() for r in _require_env("BRIEFING_RECIPIENTS").split(",")]

# Which calendars to include (name → Google Calendar ID)
CALENDARS = {
    "Parent 1":    _require_env("PARENT1_CALENDAR_ID"),
    "Parent 2":    _require_env("PARENT2_CALENDAR_ID"),
    "Family":      "your-family-calendar-id@group.calendar.google.com",
    # Add shared/imported school, sports calendars here
}

# Keywords on one parent's calendar that flag evening logistics coverage
SUTTON_UNAVAILABLE_KEYWORDS = [r"\bumd\b", r"\bclass\b", r"\bwork\b"]

# Names of your kids (used for conflict detection)
# Search for "Foster" and "Kai" in daily_briefing.py and replace with your kids' names
```

---

## Part 2 — Telegram Calendar Bot

### Step 1 · Create your Telegram bot

1. Open Telegram → search **@BotFather** → start a chat
2. Send `/newbot`
3. Follow the prompts — choose a name and a username (must end in `bot`)
4. BotFather gives you a **bot token** — save it (looks like `1234567890:ABCdef...`)

### Step 2 · Get your Telegram user IDs

Each family member who will use the bot needs to do this once:

1. Open Telegram → search **@userinfobot** → start a chat → send any message
2. It replies with your numeric **user ID** — save it (looks like `123456789`)

### Step 3 · Get your Anthropic API key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. **API Keys → Create new key** → copy it

### Step 4 · Set up Cloudflare

Cloudflare Workers is where the bot lives — it's always on and handles messages instantly.

**Install Node.js** (needed for the Wrangler CLI):
```bash
brew install node        # Mac with Homebrew
# or download from nodejs.org
```

**Install Wrangler and log in:**
```bash
npm install -g wrangler
wrangler login           # opens browser, click Allow
```

**Create the KV storage** (used to track conversation state and cache tokens):
```bash
cd telegram-bot
wrangler kv namespace create FAMILY_BOT_KV
```

Copy the `id` from the output and paste it into `telegram-bot/wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "KV"
id = "paste-your-id-here"
```

### Step 5 · Set Cloudflare secrets

Run each of these — Wrangler will prompt you to paste the value:

```bash
cd telegram-bot

printf '%s' 'YOUR_BOT_TOKEN'      | wrangler secret put TELEGRAM_BOT_TOKEN
printf '%s' 'ID1,ID2'             | wrangler secret put ALLOWED_USER_IDS
printf '%s' 'YOUR_ANTHROPIC_KEY'  | wrangler secret put ANTHROPIC_API_KEY
printf '%s' 'YOUR_TOKEN_JSON_B64' | wrangler secret put GOOGLE_TOKEN_JSON
printf '%s' 'YOUR_CREDS_JSON_B64' | wrangler secret put GOOGLE_CREDENTIALS_JSON
printf '%s' 'calendar@gmail.com'  | wrangler secret put SUTTON_CALENDAR_ID
```

| Secret | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `ALLOWED_USER_IDS` | Comma-separated Telegram user IDs for all family members |
| `ANTHROPIC_API_KEY` | From console.anthropic.com |
| `GOOGLE_TOKEN_JSON` | The base64 value printed by `setup.py` |
| `GOOGLE_CREDENTIALS_JSON` | The base64 value printed by `setup.py` |
| `SUTTON_CALENDAR_ID` | Google Calendar ID for the calendar events are added to |

Also update `JOHN_EMAIL` in `telegram-bot/wrangler.toml` to the email address that receives calendar invites:

```toml
[vars]
JOHN_EMAIL = "your-email@gmail.com"
TIMEZONE   = "America/New_York"
```

### Step 6 · Deploy and connect to Telegram

```bash
cd telegram-bot
wrangler deploy
```

Wrangler prints your Worker URL — it looks like `https://family-calendar-bot.yourname.workers.dev`

Now tell Telegram to send all bot messages to that URL:

```bash
curl "https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook?url=https://family-calendar-bot.yourname.workers.dev"
```

You should see `{"ok":true,"result":true}`.

### Step 7 · Enable the bot to read group messages

By default, Telegram bots only receive messages that start with `/`. You need to turn this off:

1. Open **@BotFather** → `/mybots` → select your bot
2. **Bot Settings → Group Privacy → Turn off**
3. BotFather confirms *"Privacy mode is disabled"*

### Step 8 · Create your family group chat

1. Create a new Telegram group with all family members
2. Add your bot (`@YourBotUsername`) to the group
3. If the bot was already in the group, **remove and re-add it** so the privacy setting takes effect

### Step 9 · Test it

Send this in the group chat:

```
Soccer practice Saturday at 10am at the park
```

The bot should reply within a few seconds with the event details and ✅ ❌ ✏️ buttons.
Tap ✅ and check Google Calendar — the event should appear with the other parent invited.

---

## Using the Bot

### Adding events

| Method | How |
|---|---|
| **Screenshot** | Take a screenshot of a text, email, or flyer → send it to the group |
| **Voice** | Hold the microphone button → speak the event → release |
| **Type** | Just describe it: *"Kai dentist Tuesday 3:30pm"* |

The bot always shows you what it found and asks for confirmation before adding anything.

### Commands

| What to send | What happens |
|---|---|
| `undo` | Removes the last event you added (within 60 seconds) |
| `/help` | Shows a quick reference |

### When the bot asks a question

If the date or time is missing, the bot will ask. Just reply naturally:
- Bot: *"What date is this?"* → You: *"Next Saturday"*
- Bot: *"What time?"* → You: *"2pm"* or *"All day"*

### Editing before confirming

Tap ✏️ then describe what to change:
- *"time is 3pm not 2pm"*
- *"location is Wakefield Park"*

### Cancellations

Send something like *"Foster's practice Saturday is cancelled"* — the bot will find the event and offer to remove it.

---

## File Reference

```
daily-family-briefing/
├── daily_briefing.py              ← Morning email script
├── setup.py                       ← One-time Google auth wizard
├── requirements.txt               ← Python dependencies
├── .github/
│   └── workflows/
│       └── daily-briefing.yml     ← GitHub Actions schedule (6:30 AM ET)
├── telegram-bot/
│   ├── src/
│   │   └── index.js               ← Cloudflare Worker (the bot)
│   └── wrangler.toml              ← Cloudflare config
├── credentials.json               ← ⚠️  Never committed — your Google OAuth client
└── token.json                     ← ⚠️  Never committed — your Google OAuth token
```

---

## Maintenance

### Adjusting the email schedule

The workflow runs at `30 11 * * *` UTC. Update `.github/workflows/daily-briefing.yml` when Daylight Saving changes:

| Season | Cron | ET time |
|---|---|---|
| Nov – Mar (EST) | `30 11 * * *` | 6:30 AM ✅ |
| Mar – Nov (EDT) | `30 10 * * *` | 6:30 AM ✅ |

### Adding calendars to the morning email

In `daily_briefing.py`, add entries to the `CALENDARS` dict:

```python
CALENDARS = {
    "Family":        "your-calendar-id@group.calendar.google.com",
    "School":        "school-calendar-id@import.calendar.google.com",
    # Add any public or shared Google Calendar here
}
```

To find a calendar ID: open it in Google Calendar → three dots → Settings → **Integrate calendar**.

### Re-authorising Google (if token expires)

Google refresh tokens rarely expire, but if the email or bot stops working:

```bash
rm token.json
python3 setup.py
```

Then update `GOOGLE_TOKEN_JSON` in both:
- GitHub: **Settings → Secrets → GOOGLE_TOKEN_JSON**
- Cloudflare: `printf '%s' 'new-value' | wrangler secret put GOOGLE_TOKEN_JSON`

### Redeploying the bot after code changes

```bash
cd telegram-bot
wrangler deploy
```

---

## Troubleshooting

**Morning email not arriving**
- Check GitHub → Actions → look for a failed run → click it to see the error log
- Most common cause: a GitHub Secret is missing or the Google token has expired

**Bot not responding in group chat**
- Confirm Group Privacy is **off** in @BotFather
- Remove the bot from the group and re-add it after changing the privacy setting
- Check the webhook is set: `curl https://api.telegram.org/botYOUR_TOKEN/getWebhookInfo`

**Bot responding but event not appearing in calendar**
- The Google token may need refreshing — re-run `setup.py` and update the Cloudflare secret
- Check that `SUTTON_CALENDAR_ID` matches exactly what's shown in Google Calendar settings

**Voice messages not working**
- Make sure **Cloud Speech-to-Text API** is enabled in Google Cloud Console
- Make sure you re-ran `setup.py` after enabling it (the token needs the new scope)
