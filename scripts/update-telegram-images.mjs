// scripts/update-telegram-images.mjs
// Node 18+ (global fetch available)

import fs from 'node:fs';
import path from 'node:path';

const token = process.env.BOT_TOKEN;
const raw = process.env.CHATS_JSON;

if (!token) {
  console.error('ERROR: BOT_TOKEN не заданий (збережи як GitHub Secret).');
  process.exit(2);
}
if (!raw) {
  console.error('ERROR: CHATS_JSON не заданий (збережи як Actions Variable).');
  process.exit(3);
}

let chats;
try {
  chats = JSON.parse(raw);
} catch (err) {
  console.error('ERROR: Не вдалося розпарсити CHATS_JSON:', err.message);
  process.exit(4);
}

if (!Array.isArray(chats) || chats.length === 0) {
  console.error('ERROR: CHATS_JSON має бути масивом з конфігурацією чатів.');
  process.exit(5);
}

const REPO_ROOT = process.cwd();
const MAP_FILE = path.join(REPO_ROOT, 'telegram-message-map.json');

// Завантаження мапи chat_id -> { message_id }
function loadMessageMap() {
  try {
    if (!fs.existsSync(MAP_FILE)) return {};
    const txt = fs.readFileSync(MAP_FILE, 'utf8').trim();
    if (!txt) return {};
    const arr = JSON.parse(txt);
    if (!Array.isArray(arr)) return {};
    const map = {};
    for (const item of arr) {
      if (item && typeof item === 'object') {
        const [k] = Object.keys(item);
        if (k) map[k] = item[k];
      }
    }
    return map;
  } catch (e) {
    console.error('WARN: Не вдалося прочитати telegram-message-map.json, починаємо з порожньої мапи:', e.message);
    return {};
  }
}

function saveMessageMap(map) {
  try {
    // повертаємо той самий формат: масив об'єктів { "chat_id": { message_id } }
    const keys = Object.keys(map).sort((a, b) => a.localeCompare(b));
    const arr = keys.map(k => ({ [k]: { message_id: map[k].message_id } }));
    const json = JSON.stringify(arr, null, 2) + '\n';
    fs.writeFileSync(MAP_FILE, json, 'utf8');
    return true;
  } catch (e) {
    console.error('ERROR: Не вдалося записати telegram-message-map.json:', e.message);
    return false;
  }
}


const messageMap = loadMessageMap();
let mapDirty = false;

const API_BASE = `https://api.telegram.org/bot${token}`;

// Форматування дати у вигляді "YYYY-MM-DD HH:mm" (Europe/Kyiv)
function getTimestamp() {
  const tz = 'Europe/Kyiv';
  const now = new Date();
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const parts = fmt.formatToParts(now);
    const get = (type) => parts.find(p => p.type === type)?.value || '';
    const yyyy = get('year');
    const mm = get('month');
    const dd = get('day');
    const hh = get('hour');
    const mi = get('minute');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  } catch {
    // Fallback: try to parse string with timeZone applied
    const s = now.toLocaleString('en-CA', { timeZone: tz, hour12: false });
    const m = s.match(/(\d{4}-\d{2}-\d{2}).(\d{2}):(\d{2})/);
    if (m) return `${m[1]} ${m[2]}:${m[3]}`;
    // Worst-case: use system time
    const pad = (n) => n.toString().padStart(2, '0');
    const yyyy = now.getFullYear();
    const mm = pad(now.getMonth() + 1);
    const dd = pad(now.getDate());
    const hh = pad(now.getHours());
    const mi = pad(now.getMinutes());
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  }
}

function withTimestamp(caption) {
  const ts = getTimestamp();
  return caption ? `${caption}\nОновлено: ${ts}` : `Оновлено: ${ts}`;
}

// Додаємо cache-busting параметр cb=timestamp до URL
function cacheBustedUrl(url) {
  try {
    const ts = Date.now();
    const u = new URL(url);
    u.searchParams.set('cb', ts.toString());
    return u.toString();
  } catch (e) {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}cb=${Date.now()}`;
  }
}

async function sendPhoto(chat) {
  const url = `${API_BASE}/sendPhoto`;
  const caption = withTimestamp(chat.caption);
  const photoUrl = cacheBustedUrl(chat.image_url);
  const body = {
    chat_id: chat.chat_id,
    photo: photoUrl,
    caption
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await res.json();
    if (!json.ok) {
      console.error(`sendPhoto ERROR for ${chat.chat_id}:`, JSON.stringify(json));
      return { ok: false, chat, json };
    }
    const messageId = json.result && json.result.message_id;
    console.log(`SENT new message for chat_id=${chat.chat_id} title="${chat.title || ''}" -> message_id=${messageId}`);
    await pinMessage(chat.chat_id, messageId);
    return { ok: true, chat, message_id: messageId, result: json.result };
  } catch (err) {
    console.error(`Network error sendPhoto for ${chat.chat_id}:`, err.message);
    return { ok: false, chat, err };
  }
}

async function editPhoto(chat, messageId) {
  const url = `${API_BASE}/editMessageMedia`;
  const caption = withTimestamp(chat.caption);
  const photoUrl = cacheBustedUrl(chat.image_url);
  const payload = {
    chat_id: chat.chat_id,
    message_id: Number(messageId),
    media: {
      type: 'photo',
      media: photoUrl,
      caption
    }
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    if (!json.ok) {
      // Обробка "message is not modified" як не-критичної ситуації
      if (json.error_code === 400 && typeof json.description === 'string' && json.description.includes('message is not modified')) {
        console.log(`NOT_MODIFIED for ${chat.chat_id}/${messageId} — content same, considered OK.`);
        await pinMessage(chat.chat_id, messageId);
        return { ok: true, chat, not_modified: true };
      }
      // Якщо 400 — наприклад, повідомлення видалене: створюємо нове
      if (json.error_code === 400) {
        console.warn(`EDIT 400 for ${chat.chat_id}/${messageId}: ${json.description}. Will send new message.`);
        const sent = await sendPhoto(chat);
        return { ...sent, replaced: true };
      }
      console.error(`editMessageMedia ERROR for ${chat.chat_id}/${messageId}:`, JSON.stringify(json));
      return { ok: false, chat, json };
    }
    console.log(`EDITED chat_id=${chat.chat_id} message_id=${messageId} OK`);
    await pinMessage(chat.chat_id, messageId);
    return { ok: true, chat, result: json.result };
  } catch (err) {
    console.error(`Network error editMessageMedia for ${chat.chat_id}/${messageId}:`, err.message);
    return { ok: false, chat, err };
  }
}

async function pinMessage(chat_id, message_id) {
  const url = `${API_BASE}/pinChatMessage`;
  try {
    const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ chat_id, message_id, disable_notification:true }) });
    const json = await res.json();
    if (!json.ok) { console.error(`pinChatMessage ERROR for ${chat_id}/${message_id}:`, JSON.stringify(json)); return { ok: false }; }
    console.log(`PINNED chat_id=${chat_id} message_id=${message_id} OK`);
    return { ok: true };
  } catch (err) {
    console.error(`Network error pinChatMessage for ${chat_id}/${message_id}:`, err.message);
    return { ok: false };
  }
}

(async () => {
  const results = [];

  const setMessageId = (chatId, messageId) => {
    if (!messageId) return;
    if (!messageMap[chatId]) messageMap[chatId] = {};
    if (messageMap[chatId].message_id !== messageId) {
      messageMap[chatId].message_id = messageId;
      mapDirty = true;
    }
  };

  for (const c of chats) {
    if (!c.chat_id || !c.image_url) {
      console.error('SKIP: конфігурація чату має містити chat_id і image_url:', JSON.stringify(c));
      results.push({ ok: false, chat: c, reason: 'invalid-config' });
      continue;
    }

    const known = messageMap[c.chat_id]?.message_id;

    if (!known) {
      // В мапі немає message_id — відправляємо нове повідомлення і зберігаємо його id
      const r = await sendPhoto(c);
      if (r.ok && r.message_id) setMessageId(c.chat_id, r.message_id);
      results.push(r);
    } else {
      // Пробуємо редагувати існуюче повідомлення за відомим message_id
      const r = await editPhoto(c, known);
      if (r.ok && r.replaced && r.message_id) {
        // Під час редагування отримали 400 і створили нове повідомлення — оновлюємо мапу
        setMessageId(c.chat_id, r.message_id);
      }
      results.push(r);
    }

    // невелика пауза, щоб не спамити API
    await new Promise(r => setTimeout(r, 600));
  }

  // Якщо мапа змінилася — зберігаємо (коміт і пуш робить GitHub Actions у наступному кроці)
  if (mapDirty) {
    const ok = saveMessageMap(messageMap);
    if (ok) {
      console.log('Message map saved to telegram-message-map.json.');
    }
  } else {
    console.log('Message map unchanged.');
  }

  // Фільтруємо реальні помилки (ок=false і не "invalid-config")
  const failures = results.filter(r => !r.ok && r.reason !== 'invalid-config');
  if (failures.length) {
    console.error(`Completed with ${failures.length} failures out of ${results.length}.`);
    // повертаємо невдалий статус, щоб Action показав failure
    process.exit(10);
  } else {
    console.log('All chats processed (success / not-modified / skipped invalid-config).');
  }
})();
