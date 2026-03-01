/**
 * Family Calendar Telegram Bot — Cloudflare Worker
 *
 * Features:
 *  📸  Screenshot / image  → Claude Vision → extract event
 *  🎤  Voice message       → OpenAI Whisper → Claude → extract event
 *  💬  Typed text          → Claude → extract event or cancellation
 *  ✅  Inline confirm / ❌ cancel / ✏️ edit buttons
 *  ↩️  "undo" within 60 seconds of creation
 *  🚫  Cancellation detection → find + offer to delete existing event
 *  🔍  Duplicate detection before creating
 *  ❓  Ambiguity handling — asks for missing date or time
 *  🔁  Recurring event support
 *
 * Events go to Sutton's calendar. John is auto-invited.
 *
 * Environment variables (set via `wrangler secret put`):
 *   TELEGRAM_BOT_TOKEN      — from @BotFather
 *   ALLOWED_USER_IDS        — comma-separated Telegram user IDs (John, Sutton)
 *   ANTHROPIC_API_KEY       — for Claude vision + understanding
 *   OPENAI_API_KEY          — for Whisper voice transcription
 *   GOOGLE_TOKEN_JSON       — base64-encoded token.json (same as GitHub Secret)
 *   GOOGLE_CREDENTIALS_JSON — base64-encoded credentials.json (same as GitHub Secret)
 *   SUTTON_CALENDAR_ID      — Sutton's Google Calendar ID
 *
 * KV namespace binding: KV  (stores token cache, pending events, undo state)
 */

const TELEGRAM_API     = 'https://api.telegram.org/bot';
const CLAUDE_API       = 'https://api.anthropic.com/v1/messages';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_API     = 'https://www.googleapis.com/calendar/v3';
const WHISPER_API      = 'https://api.openai.com/v1/audio/transcriptions';

// ─── MAIN ENTRY POINT ─────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    // Health check
    if (request.method !== 'POST') {
      return new Response('✅ Family Calendar Bot is running', { status: 200 });
    }

    try {
      const update = await request.json();

      if (update.callback_query) {
        ctx.waitUntil(handleCallbackQuery(update.callback_query, env));
      } else if (update.message) {
        ctx.waitUntil(handleMessage(update.message, env));
      }
    } catch (err) {
      console.error('Top-level error:', err);
    }

    // Always return 200 immediately so Telegram doesn't retry
    return new Response('OK', { status: 200 });
  },
};

// ─── MESSAGE ROUTER ───────────────────────────────────────────────────────────

async function handleMessage(message, env) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const senderName = message.from.first_name || 'Unknown';

  // Whitelist — only respond to John and Sutton
  const allowedIds = env.ALLOWED_USER_IDS.split(',').map(id => parseInt(id.trim()));
  if (!allowedIds.includes(userId)) {
    await sendMessage(chatId, '⛔ Not authorized.', env);
    return;
  }

  // ── Text messages ──────────────────────────────────────────────────────────
  if (message.text) {
    const text = message.text.trim();

    if (text === '/start' || text === '/help') {
      await sendHelp(chatId, env);
      return;
    }

    if (text.toLowerCase() === 'undo' || text === '/undo') {
      await handleUndo(chatId, env);
      return;
    }

    // Check if we're mid-conversation (waiting for date, time, or edit)
    const pending = await env.KV.get(`pending_${chatId}`, 'json');
    if (pending?.awaiting_field) {
      await handlePendingField(chatId, text, pending, env);
      return;
    }
    if (pending?.state === 'awaiting_edit') {
      await handleInlineEdit(chatId, text, pending, env);
      return;
    }
    if (pending?.awaiting_delete_choice) {
      await handleDeleteChoice(chatId, text, pending, env);
      return;
    }

    // Plain text → treat as event description
    await processText(chatId, text, senderName, env);
    return;
  }

  // ── Photos / screenshots ───────────────────────────────────────────────────
  if (message.photo || (message.document?.mime_type?.startsWith('image/'))) {
    await processPhoto(chatId, message, senderName, env);
    return;
  }

  // ── Voice messages ─────────────────────────────────────────────────────────
  if (message.voice) {
    await processVoice(chatId, message, senderName, env);
    return;
  }

  await sendMessage(chatId,
    'Send me a 📸 screenshot, 🎤 voice message, or 💬 type an event description!\n/help for more info.',
    env);
}

// ─── PHOTO PROCESSING ─────────────────────────────────────────────────────────

async function processPhoto(chatId, message, senderName, env) {
  await sendMessage(chatId, '📸 Got it, analyzing…', env);

  const photo = message.photo
    ? message.photo[message.photo.length - 1]  // largest size
    : message.document;

  const fileUrl  = await getTelegramFileUrl(photo.file_id, env);
  const imgBuf   = await (await fetch(fileUrl)).arrayBuffer();
  const b64Image = bufferToBase64(imgBuf);
  const mimeType = message.photo ? 'image/jpeg' : (message.document.mime_type || 'image/jpeg');

  const extraction = await extractWithClaude({ b64Image, mimeType }, env);
  await handleExtraction(chatId, extraction, senderName, env);
}

// ─── VOICE PROCESSING ─────────────────────────────────────────────────────────

async function processVoice(chatId, message, senderName, env) {
  await sendMessage(chatId, '🎤 Transcribing…', env);

  const fileUrl  = await getTelegramFileUrl(message.voice.file_id, env);
  const audioBuf = await (await fetch(fileUrl)).arrayBuffer();

  // Whisper accepts OGG/Opus (Telegram's native voice format) via multipart upload
  const formData = new FormData();
  formData.append('file', new Blob([audioBuf], { type: 'audio/ogg' }), 'voice.ogg');
  formData.append('model', 'whisper-1');
  formData.append('language', 'en');

  const whisperRes = await fetch(WHISPER_API, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}` },
    body: formData,
  });

  const whisperData = await whisperRes.json();
  const transcript  = whisperData.text?.trim();

  if (!transcript) {
    await sendMessage(chatId, "🎤 Couldn't catch that — try again or type it out?", env);
    return;
  }

  await sendMessage(chatId, `🎤 Heard: _"${transcript}"_\n\nProcessing…`, env, { parse_mode: 'Markdown' });

  const extraction = await extractWithClaude({ text: transcript }, env);
  await handleExtraction(chatId, extraction, senderName, env);
}

// ─── TEXT PROCESSING ──────────────────────────────────────────────────────────

async function processText(chatId, text, senderName, env) {
  await sendMessage(chatId, '⏳ On it…', env);
  const extraction = await extractWithClaude({ text }, env);
  await handleExtraction(chatId, extraction, senderName, env);
}

// ─── CLAUDE EVENT EXTRACTION ──────────────────────────────────────────────────

async function extractWithClaude({ text, b64Image, mimeType }, env) {
  const today = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const systemPrompt = `You are a family calendar assistant for the Mataya family.
Family: John (dad, ${env.JOHN_EMAIL}), Sutton (mom), kids: Foster and Kai.
Timezone: America/New_York. Today is ${today}.

Extract event information and return ONLY valid JSON — no markdown, no extra text.

For an EVENT return:
{
  "type": "event",
  "summary": "concise event title",
  "start_datetime": "2025-03-08T14:00:00" or null if time unknown,
  "end_datetime":   "2025-03-08T15:30:00" or null,
  "date_only":      "2025-03-08" or null (use only when there is truly no time),
  "location":       "place name" or null,
  "description":    "any useful notes" or null,
  "is_recurring":   false,
  "recurrence_rule": "FREQ=WEEKLY;BYDAY=SA;UNTIL=20250531" or null,
  "missing_fields": []  // list any that are unknown: "date", "start_time", "end_time"
}

For a CANCELLATION return:
{
  "type": "cancellation",
  "summary": "name of event being cancelled",
  "date":    "2025-03-08" or null,
  "notes":   "any context"
}

If content is unclear or unrelated to an event return:
{
  "type": "unclear",
  "question": "specific question to ask the user"
}`;

  const content = [];
  if (b64Image) {
    content.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data: b64Image } });
  }
  content.push({ type: 'text', text: text || 'What event is shown in this image?' });

  const res = await fetch(CLAUDE_API, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content }],
    }),
  });

  const data = await res.json();
  const raw  = data.content?.[0]?.text || '{}';

  try {
    return JSON.parse(raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
  } catch {
    return { type: 'unclear', question: "I had trouble reading that — could you describe the event?" };
  }
}

// ─── EXTRACTION HANDLER ───────────────────────────────────────────────────────

async function handleExtraction(chatId, extraction, senderName, env) {
  if (extraction.type === 'unclear') {
    await env.KV.put(`pending_${chatId}`, JSON.stringify({ awaiting_clarification: true }), { expirationTtl: 600 });
    await sendMessage(chatId, `🤔 ${extraction.question}`, env);
    return;
  }

  if (extraction.type === 'cancellation') {
    await handleCancellation(chatId, extraction, env);
    return;
  }

  if (extraction.type === 'event') {
    const missing = extraction.missing_fields || [];

    // Ask for date if completely missing
    if (missing.includes('date') && !extraction.start_datetime && !extraction.date_only) {
      await env.KV.put(`pending_${chatId}`, JSON.stringify({
        partial_event: extraction,
        awaiting_field: 'date',
      }), { expirationTtl: 600 });
      await sendMessage(chatId,
        `📅 Got it: *${extraction.summary}*\n\nWhat date is this?`,
        env, { parse_mode: 'Markdown' });
      return;
    }

    // Ask for time if missing (and it's not intentionally all-day)
    if (missing.includes('start_time') && !extraction.start_datetime && !extraction.date_only) {
      await env.KV.put(`pending_${chatId}`, JSON.stringify({
        partial_event: extraction,
        awaiting_field: 'start_time',
      }), { expirationTtl: 600 });
      await sendMessage(chatId,
        `⏰ Got it: *${extraction.summary}*\n\nWhat time? (Or reply "all day" if no specific time)`,
        env, { parse_mode: 'Markdown' });
      return;
    }

    const duplicate = await checkForDuplicate(extraction, env);
    await showConfirmation(chatId, extraction, duplicate, env);
  }
}

// ─── PENDING FIELD (mid-conversation date/time answers) ───────────────────────

async function handlePendingField(chatId, text, pending, env) {
  const event = pending.partial_event;
  const field = pending.awaiting_field;

  // Use Claude (haiku — fast + cheap) to parse the natural-language answer
  const res = await fetch(CLAUDE_API, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: `Today is ${new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'long', day: 'numeric' })}.
Event: "${event.summary}". User said: "${text}" to provide the missing ${field}.
Return ONLY a JSON object with the resolved fields.
For start_time: include start_datetime and end_datetime (ISO 8601, America/New_York offset, default 1hr if end unknown).
For date: include date_only ("YYYY-MM-DD") or start_datetime if time was also given.
If user said "all day", return {"date_only": "YYYY-MM-DD"}.`,
      }],
    }),
  });

  const data = await res.json();
  let parsed = {};
  try {
    parsed = JSON.parse(data.content[0].text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
  } catch { /* leave parsed empty */ }

  const updated = { ...event, ...parsed };
  updated.missing_fields = (event.missing_fields || []).filter(f => f !== field);

  // Still missing time after getting date?
  if (updated.missing_fields.includes('start_time') && !updated.start_datetime && !updated.date_only) {
    await env.KV.put(`pending_${chatId}`, JSON.stringify({
      partial_event: updated,
      awaiting_field: 'start_time',
    }), { expirationTtl: 600 });
    await sendMessage(chatId, `⏰ What time? (Or "all day")`, env);
    return;
  }

  await env.KV.delete(`pending_${chatId}`);
  const duplicate = await checkForDuplicate(updated, env);
  await showConfirmation(chatId, updated, duplicate, env);
}

// ─── INLINE EDIT (after pressing ✏️) ─────────────────────────────────────────

async function handleInlineEdit(chatId, text, pending, env) {
  const event = pending.confirmed_event || pending.partial_event;
  await sendMessage(chatId, '🔄 Updating…', env);

  const res = await fetch(CLAUDE_API, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `Current event: ${JSON.stringify(event)}
User wants to change: "${text}"
Return ONLY a JSON object with the updated fields (only the fields that changed).`,
      }],
    }),
  });

  const data  = await res.json();
  let changes = {};
  try {
    changes = JSON.parse(data.content[0].text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
  } catch { /* ignore */ }

  const updated = { ...event, ...changes };
  await env.KV.delete(`pending_${chatId}`);
  await showConfirmation(chatId, updated, null, env);
}

// ─── CONFIRMATION CARD ────────────────────────────────────────────────────────

async function showConfirmation(chatId, event, duplicate, env) {
  const timeStr = formatEventTime(event);

  let msg = `📅 *${escMd(event.summary)}*\n`;
  msg    += `🗓 ${escMd(timeStr)}\n`;
  if (event.location)  msg += `📍 ${escMd(event.location)}\n`;
  if (event.description) msg += `📝 ${escMd(event.description)}\n`;
  if (event.is_recurring) msg += `🔁 Recurring event\n`;
  msg += `\nAdd to Sutton's calendar & invite John?`;

  if (duplicate) {
    msg += `\n\n⚠️ *Possible duplicate:* "${escMd(duplicate.summary)}" is already on the calendar for this date.`;
  }

  const buttons = [[
    { text: '✅ Add it',   callback_data: `confirm:${chatId}` },
    { text: '❌ Cancel',  callback_data: `cancel:${chatId}` },
    { text: '✏️ Edit',    callback_data: `edit:${chatId}` },
  ]];

  await env.KV.put(`pending_${chatId}`, JSON.stringify({
    confirmed_event: event,
    state: 'awaiting_confirmation',
  }), { expirationTtl: 600 });

  await sendMessage(chatId, msg, env, {
    parse_mode: 'Markdown',
    reply_markup: JSON.stringify({ inline_keyboard: buttons }),
  });
}

// ─── CALLBACK QUERY HANDLER (button taps) ────────────────────────────────────

async function handleCallbackQuery(cbq, env) {
  const chatId    = cbq.message.chat.id;
  const msgId     = cbq.message.message_id;
  const data      = cbq.data;

  await answerCallbackQuery(cbq.id, env);

  // ── Delete confirmation (cancellation flow) ───────────────────────────────
  if (data.startsWith('delete:')) {
    const [, eventId] = data.split(':');
    await deleteCalendarEvent(eventId, env);
    await editMessage(chatId, msgId, '🗑 Event removed from the calendar.', env);
    return;
  }

  const pending = await env.KV.get(`pending_${chatId}`, 'json');

  // ── Confirm → create event ────────────────────────────────────────────────
  if (data.startsWith('confirm') && pending?.confirmed_event) {
    const event = pending.confirmed_event;
    await env.KV.delete(`pending_${chatId}`);

    const created = await createCalendarEvent(event, env);
    if (created) {
      const timeStr = formatEventTime(event);

      // Store for undo (60-second window)
      await env.KV.put(`last_event_${chatId}`, JSON.stringify({
        id: created.id, summary: event.summary, timeStr,
      }), { expirationTtl: 3600 });
      await env.KV.put(`last_event_time_${chatId}`, Date.now().toString(), { expirationTtl: 120 });

      await editMessage(chatId, msgId,
        `✅ *${escMd(event.summary)}* added\\!\n🗓 ${escMd(timeStr)}\n📧 John invited\\.\n\n_Reply "undo" within 60 seconds to remove\\._`,
        env, { parse_mode: 'MarkdownV2' });
    } else {
      await editMessage(chatId, msgId, '❌ Something went wrong — try again?', env);
    }
    return;
  }

  // ── Cancel ────────────────────────────────────────────────────────────────
  if (data.startsWith('cancel')) {
    await env.KV.delete(`pending_${chatId}`);
    await editMessage(chatId, msgId, '👋 Cancelled — nothing was added.', env);
    return;
  }

  // ── Edit ──────────────────────────────────────────────────────────────────
  if (data.startsWith('edit') && pending) {
    await env.KV.put(`pending_${chatId}`, JSON.stringify({
      ...pending,
      state: 'awaiting_edit',
    }), { expirationTtl: 600 });
    await editMessage(chatId, msgId,
      `✏️ What would you like to change?\n\nExamples:\n• "time is 3pm"\n• "location is Wakefield Park"\n• "title is Foster Practice"`,
      env);
    return;
  }
}

// ─── UNDO (60-second window) ──────────────────────────────────────────────────

async function handleUndo(chatId, env) {
  const [lastEvent, lastTime] = await Promise.all([
    env.KV.get(`last_event_${chatId}`, 'json'),
    env.KV.get(`last_event_time_${chatId}`),
  ]);

  if (!lastEvent) {
    await sendMessage(chatId, '🤷 No recent event to undo.', env);
    return;
  }

  const age = Date.now() - parseInt(lastTime || '0');
  if (age > 60_000) {
    await sendMessage(chatId,
      `⏰ Undo window has passed (60 seconds).\n\n*${escMd(lastEvent.summary)}* is on the calendar — delete it there if needed.`,
      env, { parse_mode: 'Markdown' });
    return;
  }

  await deleteCalendarEvent(lastEvent.id, env);
  await Promise.all([
    env.KV.delete(`last_event_${chatId}`),
    env.KV.delete(`last_event_time_${chatId}`),
  ]);
  await sendMessage(chatId,
    `↩️ Done — *${escMd(lastEvent.summary)}* was removed from the calendar.`,
    env, { parse_mode: 'Markdown' });
}

// ─── CANCELLATION HANDLER ────────────────────────────────────────────────────

async function handleCancellation(chatId, cancellation, env) {
  await sendMessage(chatId, `🔍 Looking for "${cancellation.summary}" on the calendar…`, env);
  const matches = await findMatchingEvents(cancellation.summary, cancellation.date, env);

  if (matches.length === 0) {
    await sendMessage(chatId,
      `🤷 Couldn't find *${escMd(cancellation.summary)}* on the calendar.\nCheck Google Calendar directly to delete it.`,
      env, { parse_mode: 'Markdown' });
    return;
  }

  if (matches.length === 1) {
    const m = matches[0];
    const dateStr = m.start?.dateTime || m.start?.date || '';
    await sendMessage(chatId,
      `🚫 Found: *${escMd(m.summary)}*\n🗓 ${escMd(dateStr)}\n\nRemove this from the calendar?`,
      env, {
        parse_mode: 'Markdown',
        reply_markup: JSON.stringify({ inline_keyboard: [[
          { text: '🗑 Yes, remove it', callback_data: `delete:${m.id}:${chatId}` },
          { text: '❌ Keep it',        callback_data: `cancel:${chatId}` },
        ]] }),
      });
    return;
  }

  // Multiple matches — ask which one
  let msg = `🔍 Found ${matches.length} possible matches:\n\n`;
  matches.forEach((m, i) => {
    const d = m.start?.dateTime || m.start?.date || '';
    msg += `${i + 1}\\. *${escMd(m.summary)}* — ${escMd(d)}\n`;
  });
  msg += '\nReply with the number to delete it.';

  await env.KV.put(`pending_${chatId}`, JSON.stringify({
    matches,
    awaiting_delete_choice: true,
  }), { expirationTtl: 300 });
  await sendMessage(chatId, msg, env, { parse_mode: 'MarkdownV2' });
}

async function handleDeleteChoice(chatId, text, pending, env) {
  const num = parseInt(text.trim());
  if (isNaN(num) || num < 1 || num > pending.matches.length) {
    await sendMessage(chatId, `Please reply with a number between 1 and ${pending.matches.length}.`, env);
    return;
  }
  const m = pending.matches[num - 1];
  await env.KV.delete(`pending_${chatId}`);
  await deleteCalendarEvent(m.id, env);
  await sendMessage(chatId, `🗑 Removed *${escMd(m.summary)}* from the calendar.`, env, { parse_mode: 'Markdown' });
}

// ─── DUPLICATE CHECK ──────────────────────────────────────────────────────────

async function checkForDuplicate(event, env) {
  const dateStr = event.start_datetime?.substring(0, 10) || event.date_only;
  if (!dateStr) return null;

  try {
    const token   = await getGoogleAccessToken(env);
    const calId   = encodeURIComponent(env.SUTTON_CALENDAR_ID);
    const timeMin = `${dateStr}T00:00:00-05:00`;
    const timeMax = `${dateStr}T23:59:59-05:00`;

    const res  = await fetch(
      `${CALENDAR_API}/calendars/${calId}/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const newN = norm(event.summary);

    return (data.items || []).find(e => {
      const exN = norm(e.summary);
      return exN === newN || exN.includes(newN) || newN.includes(exN);
    }) || null;
  } catch { return null; }
}

// ─── FIND EVENTS BY NAME (for cancellation) ───────────────────────────────────

async function findMatchingEvents(summary, date, env) {
  try {
    const token   = await getGoogleAccessToken(env);
    const calId   = encodeURIComponent(env.SUTTON_CALENDAR_ID);
    const anchor  = date ? new Date(date + 'T12:00:00-05:00') : new Date();
    const timeMin = new Date(anchor.getTime() - 7 * 86_400_000).toISOString();
    const timeMax = new Date(anchor.getTime() + 14 * 86_400_000).toISOString();

    const res  = await fetch(
      `${CALENDAR_API}/calendars/${calId}/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&maxResults=100`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const searchN = norm(summary);

    return (data.items || []).filter(e => {
      const en = norm(e.summary);
      return en.includes(searchN) || searchN.includes(en);
    });
  } catch { return []; }
}

// ─── CREATE CALENDAR EVENT ────────────────────────────────────────────────────

async function createCalendarEvent(event, env) {
  const token = await getGoogleAccessToken(env);
  const calId = encodeURIComponent(env.SUTTON_CALENDAR_ID);

  const body = {
    summary:     event.summary,
    description: event.description || '',
    location:    event.location    || '',
    attendees:   [{ email: env.JOHN_EMAIL }],
    reminders:   { useDefault: true },
  };

  if (event.start_datetime) {
    body.start = { dateTime: event.start_datetime, timeZone: 'America/New_York' };
    body.end   = {
      dateTime: event.end_datetime || addHours(event.start_datetime, 1),
      timeZone: 'America/New_York',
    };
  } else {
    body.start = { date: event.date_only };
    body.end   = { date: event.date_only };
  }

  if (event.is_recurring && event.recurrence_rule) {
    body.recurrence = [`RRULE:${event.recurrence_rule}`];
  }

  const res    = await fetch(
    `${CALENDAR_API}/calendars/${calId}/events?sendUpdates=all`,
    {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    }
  );
  const created = await res.json();
  return created.id ? created : null;
}

// ─── DELETE CALENDAR EVENT ────────────────────────────────────────────────────

async function deleteCalendarEvent(eventId, env) {
  const token = await getGoogleAccessToken(env);
  const calId = encodeURIComponent(env.SUTTON_CALENDAR_ID);
  await fetch(`${CALENDAR_API}/calendars/${calId}/events/${eventId}`, {
    method:  'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ─── GOOGLE OAUTH TOKEN MANAGEMENT ───────────────────────────────────────────
// Uses the same token.json / credentials.json pair as the daily briefing.
// Caches the short-lived access token in KV; refreshes via refresh_token.

async function getGoogleAccessToken(env) {
  // Check KV cache
  const cached = await env.KV.get('google_access_token', 'json');
  if (cached && cached.expiry > Date.now() + 30_000) return cached.token;

  // Decode stored credentials (base64-encoded, same format as GitHub Secrets)
  const tokenData = JSON.parse(atob(env.GOOGLE_TOKEN_JSON));
  const credsData = JSON.parse(atob(env.GOOGLE_CREDENTIALS_JSON));
  const installed = credsData.installed || credsData.web;

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      client_id:     installed.client_id,
      client_secret: installed.client_secret,
      refresh_token: tokenData.refresh_token,
      grant_type:    'refresh_token',
    }),
  });

  const refreshed = await res.json();
  if (!refreshed.access_token) {
    throw new Error('Google token refresh failed: ' + JSON.stringify(refreshed));
  }

  // Cache it
  await env.KV.put('google_access_token', JSON.stringify({
    token:  refreshed.access_token,
    expiry: Date.now() + (refreshed.expires_in - 120) * 1000,
  }), { expirationTtl: refreshed.expires_in });

  return refreshed.access_token;
}

// ─── HELP MESSAGE ─────────────────────────────────────────────────────────────

async function sendHelp(chatId, env) {
  const msg = `👋 *Family Calendar Bot*

Send me any of these:
📸 *Screenshot* — of a text, email, or flyer
🎤 *Voice message* — describe an event out loud
💬 *Text* — "Foster soccer Saturday 2pm Wakefield"

I'll confirm the details before adding anything\\.

*Commands:*
\`undo\` — remove the last event \\(within 60 sec\\)
\`/help\` — show this message

Events go to Sutton's calendar\\. John gets an invite automatically\\.`;

  await sendMessage(chatId, msg, env, { parse_mode: 'MarkdownV2' });
}

// ─── TELEGRAM API HELPERS ─────────────────────────────────────────────────────

async function sendMessage(chatId, text, env, extra = {}) {
  await fetch(`${TELEGRAM_API}${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, text, ...extra }),
  });
}

async function editMessage(chatId, messageId, text, env, extra = {}) {
  await fetch(`${TELEGRAM_API}${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, message_id: messageId, text, ...extra }),
  });
}

async function answerCallbackQuery(id, env) {
  await fetch(`${TELEGRAM_API}${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ callback_query_id: id }),
  });
}

async function getTelegramFileUrl(fileId, env) {
  const res  = await fetch(`${TELEGRAM_API}${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const data = await res.json();
  return `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${data.result.file_path}`;
}

// ─── UTILITY ──────────────────────────────────────────────────────────────────

function bufferToBase64(buffer) {
  const bytes  = new Uint8Array(buffer);
  let   binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function formatEventTime(event) {
  if (event.start_datetime) {
    const startStr = formatISOasET(event.start_datetime);
    const endStr   = event.end_datetime ? formatISOasET(event.end_datetime, true) : null;
    return endStr ? `${startStr} – ${endStr}` : startStr;
  }

  if (event.date_only) {
    // Use noon UTC so the date is unambiguous across timezones
    const [y, m, d] = event.date_only.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.toLocaleDateString('en-US', {
      weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC',
    }) + ' (all day)';
  }

  return 'Time TBD';
}

/**
 * Format an ISO datetime string (e.g. "2026-02-28T10:00:00") as Eastern time
 * WITHOUT passing it through new Date(), which Cloudflare Workers would treat
 * as UTC — causing a 5-hour display offset even though the calendar event
 * itself is created correctly (Google Calendar receives the timeZone field).
 */
function formatISOasET(isoStr, timeOnly = false) {
  const [datePart, timePart] = isoStr.split('T');
  const [year, month, day]   = datePart.split('-').map(Number);
  const [hour, minute]       = timePart.split(':').map(Number);

  const period = hour >= 12 ? 'PM' : 'AM';
  const h      = hour % 12 || 12;
  const m      = minute > 0 ? `:${minute.toString().padStart(2, '0')}` : '';
  const timeStr = `${h}${m} ${period}`;

  if (timeOnly) return timeStr;

  // Use UTC-interpreted date so the day name is stable regardless of runtime TZ
  const dayRef    = new Date(Date.UTC(year, month - 1, day));
  const DAYS      = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const MONTHS    = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dayName   = DAYS[dayRef.getUTCDay()];
  const monthName = MONTHS[month - 1];

  return `${dayName}, ${monthName} ${day}, ${timeStr}`;
}

function addHours(isoStr, hours) {
  // Parse and add hours manually — avoids Cloudflare Workers treating the
  // naive ISO string as UTC and producing a wrong end time.
  const [datePart, timePart] = isoStr.split('T');
  const [year, month, day]   = datePart.split('-').map(Number);
  const [hour, minute, sec]  = timePart.split(':').map(Number);

  let newHour = hour + hours;
  let newDay  = day;

  if (newHour >= 24) { newHour -= 24; newDay += 1; }

  const pad = n => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(newDay)}T${pad(newHour)}:${pad(minute)}:${pad(sec || 0)}`;
}

// Escape special chars for Telegram MarkdownV2
function escMd(str) {
  return (str || '').replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}
