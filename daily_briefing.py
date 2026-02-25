#!/usr/bin/env python3
"""
Daily Family Briefing — John & Sutton Mataya
Runs via GitHub Actions at 6:30 AM ET every day.
Emails a day + week view with conflict detection to both john and sutton.

Credentials are read from environment variables (GitHub Secrets) so
nothing sensitive ever lives in the repository.
"""

import os
import sys
import json
import base64
import re
import datetime
import pytz
from pathlib import Path
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

# Load ~/.env for local development (optional — install python-dotenv to use)
try:
    from dotenv import load_dotenv
    load_dotenv(Path.home() / ".env")
except ImportError:
    pass

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

# ─── CONFIGURATION ────────────────────────────────────────────────────────────

TIMEZONE = "America/New_York"


def _require_env(name: str) -> str:
    """Return an environment variable value or exit with a clear error message."""
    val = os.environ.get(name, "").strip()
    if not val:
        print(f"ERROR: Required environment variable '{name}' is not set.")
        print("  For local runs:       add it to ~/.env  (see .env.example)")
        print("  For GitHub Actions:   add it as a GitHub Secret")
        sys.exit(1)
    return val


SENDER     = _require_env("BRIEFING_SENDER")
RECIPIENTS = [r.strip() for r in _require_env("BRIEFING_RECIPIENTS").split(",") if r.strip()]
_JOHN_ID   = _require_env("JOHN_CALENDAR_ID")
_SUTTON_ID = _require_env("SUTTON_CALENDAR_ID")

CALENDARS = {
    "John":               _JOHN_ID,
    "Sutton":             _SUTTON_ID,
    "Family":             "family15193680876382494899@group.calendar.google.com",
    "Arlington Schools":  "3r4onhtersmi5hjrmuhknrrls1gqe0vi@import.calendar.google.com",
    "All-Stars Baseball": "1iuoufcggph8urbobsgnfikspcmvcc5b@import.calendar.google.com",
    "Kids Basketball":    "kmho7vounu05o45fral93kqi14@group.calendar.google.com",
    "Cubs Sports":        "935rsafqkfciefs72071t9a7dn1v8rv3@import.calendar.google.com",
}

SCOPES = [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/gmail.send",
]

# Sutton events that mean John should cover evening logistics
# Uses word-boundary regex so "work" won't match "workout"
SUTTON_UNAVAILABLE_KEYWORDS = [r"\bumd\b", r"\bclass\b", r"\bwork\b", r"\bconference\b", r"\bmeeting\b"]

# ─── AUTH: reads from env vars (GitHub Secrets) or local files ───────────────

def get_credentials():
    """
    Load Google credentials from environment variables when running in CI,
    or from local token.json when running on your machine.
    """
    creds = None

    # ── GitHub Actions / CI path ──────────────────────────────────────────
    token_env = os.environ.get("GOOGLE_TOKEN_JSON")
    creds_env = os.environ.get("GOOGLE_CREDENTIALS_JSON")

    if token_env:
        # token is base64-encoded in the secret
        token_json = base64.b64decode(token_env).decode("utf-8")
        creds = Credentials.from_authorized_user_info(json.loads(token_json), SCOPES)

    # ── Local development path ────────────────────────────────────────────
    else:
        token_file = Path(__file__).parent / "token.json"
        if token_file.exists():
            creds = Credentials.from_authorized_user_file(str(token_file), SCOPES)

    # Refresh if expired
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
        # Write refreshed token back to file (local) or print for secret update (CI)
        if not token_env:
            token_file = Path(__file__).parent / "token.json"
            token_file.write_text(creds.to_json())
        else:
            # Print the refreshed token so it can be updated as a GitHub Secret if needed
            refreshed = base64.b64encode(creds.to_json().encode()).decode()
            print(f"::notice::Token refreshed. Update GOOGLE_TOKEN_JSON secret if needed: {refreshed[:40]}...")

    if not creds or not creds.valid:
        print("ERROR: No valid credentials found.")
        print("Run setup.py locally to authenticate, then follow the README to add secrets.")
        sys.exit(1)

    return creds

# ─── CALENDAR HELPERS ─────────────────────────────────────────────────────────

def get_week_events(service, days_ahead=7):
    tz      = pytz.timezone(TIMEZONE)
    now     = datetime.datetime.now(tz)
    today   = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end     = today + datetime.timedelta(days=days_ahead)

    all_events = []
    for cal_name, cal_id in CALENDARS.items():
        try:
            result = service.events().list(
                calendarId=cal_id,
                timeMin=today.isoformat(),
                timeMax=end.isoformat(),
                singleEvents=True,
                orderBy="startTime",
                maxResults=50,
            ).execute()
            for event in result.get("items", []):
                event["_calendar"] = cal_name
                all_events.append(event)
        except Exception as e:
            print(f"Warning: Could not fetch calendar '{cal_name}': {e}")

    # Sort by start time, then by calendar priority so the preferred version
    # of any duplicate is always encountered first.
    cal_priority = {"John": 0, "Family": 1, "Sutton": 2}
    all_events.sort(key=lambda x: (
        x.get("start", {}).get("dateTime", x.get("start", {}).get("date", "")),
        cal_priority.get(x.get("_calendar", ""), 9),
    ))

    # Pass 1 — deduplicate by iCalUID (RFC5545 standard UID shared across
    # calendar instances of the same real-world event; catches invitations
    # that appear on both John's and Sutton's calendars via Google invite).
    seen_uid, pass1 = set(), []
    for e in all_events:
        uid = e.get("iCalUID") or e["id"]
        if uid not in seen_uid:
            seen_uid.add(uid)
            pass1.append(e)

    # Pass 2 — deduplicate by normalised title + start minute (catches events
    # entered independently on multiple calendars with different iCalUIDs,
    # e.g. both John and Sutton each added "Brandon - John Drinks" separately).
    seen_key, unique = set(), []
    for e in pass1:
        start_val = e.get("start", {}).get("dateTime") or e.get("start", {}).get("date", "")
        title_key = re.sub(r"[^a-z0-9]", "", e.get("summary", "").lower())
        dedup_key = (title_key, start_val[:16])   # minute-level precision
        if dedup_key not in seen_key:
            seen_key.add(dedup_key)
            unique.append(e)

    return unique, today, tz


def parse_event_time(event, tz):
    start = event.get("start", {})
    end   = event.get("end", {})
    if "dateTime" in start:
        s = datetime.datetime.fromisoformat(start["dateTime"]).astimezone(tz)
        e = datetime.datetime.fromisoformat(end["dateTime"]).astimezone(tz)
        return s, e, False
    date_str = start.get("date", "")
    s = datetime.datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=tz)
    return s, s, True


def group_by_day(events, tz):
    by_day = {}
    for event in events:
        s, e, all_day = parse_event_time(event, tz)
        key = s.date()
        by_day.setdefault(key, []).append({"event": event, "start": s, "end": e, "all_day": all_day})
    return by_day


def fmt_time(dt, all_day=False):
    return "All day" if all_day else dt.strftime("%-I:%M %p")


def who_is_it(event):
    s   = event.get("summary", "").lower()
    cal = event.get("_calendar", "")
    parts = []
    if "foster" in s: parts.append("Foster")
    if "kai" in s:    parts.append("Kai")
    if "sutton" in s or cal == "Sutton": parts.append("Sutton")
    if not parts:
        if cal == "John":   parts.append("John")
        elif cal == "Family": parts.append("Family")
    return "/".join(parts)


def sutton_unavailable(item):
    """
    Flag Sutton-calendar events that affect EVENING logistics.
    Only triggers when:
      1. Event is on Sutton's calendar
      2. Summary matches a keyword via word-boundary regex
      3. Event starts at 4 PM+ OR ends after 5 PM
    """
    event = item["event"]
    summary = event.get("summary", "").lower()
    if event.get("_calendar") != "Sutton":
        return False
    if not any(re.search(pat, summary) for pat in SUTTON_UNAVAILABLE_KEYWORDS):
        return False
    # All-day events on Sutton's calendar with a keyword are flagged
    if item["all_day"]:
        return True
    # Evening-relevance filter
    start_hour = item["start"].hour
    end_hour = item["end"].hour
    end_minute = item["end"].minute
    return start_hour >= 16 or end_hour > 17 or (end_hour == 17 and end_minute > 0)


def find_conflicts(day_events):
    """Flag when two different kids need to be in different places at the same time."""
    conflicts = []
    timed = [e for e in day_events if not e["all_day"]]
    for i in range(len(timed)):
        for j in range(i + 1, len(timed)):
            a, b = timed[i], timed[j]
            if a["start"] < b["end"] and b["start"] < a["end"]:
                wa, wb = who_is_it(a["event"]), who_is_it(b["event"])
                a_kid = "Foster" in wa or "Kai" in wa
                b_kid = "Foster" in wb or "Kai" in wb
                if a_kid and b_kid and wa != wb:
                    conflicts.append((a, b))
    return conflicts

# ─── SUMMARY BUILDER ─────────────────────────────────────────────────────────

def build_summary_bullets(by_day, today_date, all_conflicts, sutton_away):
    """Return up to 4 summary bullet strings for the quick-scan section."""
    day_names = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]
    bullets = []

    # 1. Today's snapshot — always shown
    today_events = by_day.get(today_date, [])
    timed_today = [e for e in today_events if not e["all_day"]]
    if timed_today:
        first = min(timed_today, key=lambda e: e["start"])
        first_name = first["event"].get("summary", "(No title)")
        first_time = fmt_time(first["start"])
        n = len(timed_today)
        bullets.append(
            f"{n} event{'s' if n != 1 else ''} today "
            f"&mdash; first up: <strong>{first_name}</strong> at {first_time}"
        )
    else:
        bullets.append("No timed events scheduled today")

    # 2. Logistics conflicts this week
    if all_conflicts:
        conflict_days = sorted(set(day for day, _, _ in all_conflicts))
        day_labels = [day_names[d.weekday()] for d in conflict_days]
        bullets.append(
            f"🚗 Ride conflicts on <strong>{', '.join(day_labels)}</strong> "
            f"&mdash; two kids need to be in different places at the same time"
        )

    # 3. Sutton unavailable — one bullet per evening
    for item in sutton_away:
        if len(bullets) >= 4:
            break
        ev = item["event"]
        day_label = day_names[item["start"].weekday()]
        summary = ev.get("summary", "")
        bullets.append(
            f"📚 Sutton unavailable {day_label} evening "
            f"(<strong>{summary}</strong>) &mdash; John covers bedtime/logistics"
        )

    # 4. Week total / busiest day — fill to 4 if space
    if len(bullets) < 4:
        future_days = {d: evs for d, evs in by_day.items() if d >= today_date}
        total = sum(len(evs) for evs in future_days.values())
        if future_days:
            busiest_day = max(future_days, key=lambda d: len(future_days[d]))
            busiest_name = day_names[busiest_day.weekday()]
            busiest_count = len(future_days[busiest_day])
            bullets.append(
                f"{total} events this week &mdash; busiest day is "
                f"<strong>{busiest_name}</strong> with {busiest_count}"
            )

    return bullets[:4]

# ─── EMAIL HTML BUILDER ───────────────────────────────────────────────────────

def build_html(events, today, tz):
    by_day     = group_by_day(events, tz)
    today_date = today.date()
    today_str  = today.strftime("%A, %B %-d, %Y")
    day_names  = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]

    # Collect alerts
    all_conflicts = [
        (day, a, b)
        for day, day_evs in by_day.items()
        for a, b in find_conflicts(day_evs)
    ]
    sutton_away = [
        item
        for day_evs in by_day.values()
        for item in day_evs
        if sutton_unavailable(item)
    ]

    html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8">
<style>
  body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;margin:0;padding:20px;color:#222}}
  .wrap{{max-width:680px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)}}
  .hdr{{background:#1a1a2e;color:#fff;padding:24px 28px}}
  .hdr h1{{margin:0;font-size:22px;font-weight:600}}
  .hdr p{{margin:6px 0 0;opacity:.7;font-size:14px}}
  .sec{{padding:18px 28px;border-bottom:1px solid #f0f0f0}}
  .sec-title{{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#999;margin:0 0 12px}}
  .summary{{background:#eef4fb;border-radius:8px;padding:14px 20px;margin:0}}
  .summary ul{{margin:0;padding:0 0 0 18px;list-style:disc}}
  .summary li{{font-size:14px;line-height:1.6;color:#333;margin-bottom:4px}}
  .alert{{border-left:4px solid #ff9800;background:#fff8e1;padding:10px 14px;border-radius:4px;margin-bottom:8px;font-size:14px;line-height:1.4}}
  .day{{margin-bottom:18px}}
  .day-hdr{{font-size:15px;font-weight:700;color:#1a1a2e;padding:7px 0 5px;border-bottom:2px solid #eee;margin-bottom:6px}}
  .day-hdr.today-hdr{{color:#0d47a1}}
  .ev{{display:flex;gap:12px;padding:5px 0;font-size:14px;border-bottom:1px solid #fafafa}}
  .ev-time{{color:#777;min-width:130px;font-size:13px;padding-top:1px}}
  .ev-body{{flex:1}}
  .ev-title{{font-weight:500}}
  .ev-meta{{font-size:12px;color:#aaa;margin-top:2px}}
  .conflict-note{{background:#fff0f0;border:1px solid #ffcdd2;border-radius:5px;padding:8px 12px;margin-top:6px;font-size:13px}}
  .ftr{{padding:14px 28px;font-size:12px;color:#bbb;text-align:center}}
  a{{color:#1a1a2e}}
</style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <h1>📅 Daily Family Briefing</h1>
    <p>{today_str}</p>
  </div>
"""

    # ── Quick Summary ────────────────────────────────────────────────────────
    summary_bullets = build_summary_bullets(by_day, today_date, all_conflicts, sutton_away)
    html += '<div class="sec"><p class="sec-title">📋 Quick Summary</p>\n'
    html += '<div class="summary"><ul>\n'
    for bullet in summary_bullets:
        html += f'  <li>{bullet}</li>\n'
    html += '</ul></div>\n</div>\n'

    # ── Logistics Alerts ─────────────────────────────────────────────────────
    if all_conflicts or sutton_away:
        html += '<div class="sec"><p class="sec-title">🚗 Logistics Alerts</p>\n'
        for day, a, b in all_conflicts:
            label = day.strftime("%A %-d")
            html += (f'<div class="alert">🚗 <strong>Logistics gap {label}:</strong> '
                     f'{a["event"].get("summary","")} ({fmt_time(a["start"])}) overlaps '
                     f'{b["event"].get("summary","")} ({fmt_time(b["start"])}) &mdash; '
                     f'two kids need rides at the same time</div>\n')
        for item in sutton_away:
            ev = item["event"]
            html += (f'<div class="alert">📚 <strong>Sutton unavailable:</strong> '
                     f'{ev.get("summary","")} {fmt_time(item["start"])}–{fmt_time(item["end"])} &mdash; '
                     f'John covers evening logistics</div>\n')
        html += '</div>\n'

    # ── Day-by-day ──────────────────────────────────────────────────────────
    html += '<div class="sec"><p class="sec-title">This Week</p>\n'

    for day in sorted(by_day):
        if day < today_date:
            continue
        day_evs    = by_day[day]
        is_today   = (day == today_date)
        day_label  = "TODAY ✦ " + day.strftime("%A") if is_today else day_names[day.weekday()]
        date_label = day.strftime("%-d %b")
        hdr_class  = "day-hdr today-hdr" if is_today else "day-hdr"
        conflicts  = find_conflicts(day_evs)
        flagged    = {id for a, b in conflicts for id in (a["event"]["id"], b["event"]["id"])}

        html += f'<div class="day"><div class="{hdr_class}">{day_label} &middot; {date_label}</div>\n'

        for item in day_evs:
            ev       = item["event"]
            t_start  = fmt_time(item["start"], item["all_day"])
            t_end    = fmt_time(item["end"],   item["all_day"])
            time_str = t_start if item["all_day"] else f"{t_start}–{t_end}"
            title    = ev.get("summary", "(No title)")
            flag     = " ⚠️" if ev["id"] in flagged else ""
            who      = who_is_it(ev)
            loc      = ev.get("location", "")
            if loc and len(loc) > 50: loc = loc[:50] + "…"
            meta_parts = []
            if who: meta_parts.append(f"👤 {who}")
            if loc: meta_parts.append(f"📍 {loc}")
            meta = " &nbsp;·&nbsp; ".join(meta_parts)

            html += f'''<div class="ev">
  <div class="ev-time">{time_str}</div>
  <div class="ev-body">
    <div class="ev-title">{title}{flag}</div>
    {"<div class='ev-meta'>" + meta + "</div>" if meta else ""}
  </div>
</div>\n'''

        for a, b in conflicts:
            html += (f'<div class="conflict-note">⚠️ <strong>{a["event"].get("summary","")}</strong> '
                     f'overlaps with <strong>{b["event"].get("summary","")}</strong> — '
                     f'both kids need to be somewhere at the same time</div>\n')

        html += '</div>\n'

    html += '</div>\n'

    # ── Footer ───────────────────────────────────────────────────────────────
    gen_time = datetime.datetime.now(tz).strftime("%-I:%M %p")
    html += f'''<div class="ftr">
  Generated at {gen_time} ET &nbsp;·&nbsp;
  <a href="https://calendar.google.com">Open Google Calendar</a>
</div>
</div></body></html>'''

    return html

# ─── SEND EMAIL ───────────────────────────────────────────────────────────────

def send_email(gmail_svc, subject, html, recipients, sender):
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"]    = sender
    msg["To"]      = ", ".join(recipients)
    msg.attach(MIMEText(html, "html"))
    raw    = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    result = gmail_svc.users().messages().send(userId="me", body={"raw": raw}).execute()
    return result

# ─── MAIN ─────────────────────────────────────────────────────────────────────

def main():
    print("🔐 Loading credentials...")
    creds = get_credentials()

    cal_svc   = build("calendar", "v3", credentials=creds)
    gmail_svc = build("gmail",    "v1", credentials=creds)

    print("📅 Fetching events for the next 7 days...")
    events, today, tz = get_week_events(cal_svc, days_ahead=7)
    print(f"   {len(events)} events found across all calendars")

    print("✉️  Building email...")
    subject  = f"📅 Daily Briefing — {today.strftime('%A, %B %-d')}"
    html     = build_html(events, today, tz)

    print(f"📤 Sending to {', '.join(RECIPIENTS)}...")
    result = send_email(gmail_svc, subject, html, RECIPIENTS, SENDER)
    print(f"✅ Done — message ID: {result.get('id')}")


if __name__ == "__main__":
    main()
