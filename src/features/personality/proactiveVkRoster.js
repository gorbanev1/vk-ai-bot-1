import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const PROACTIVE_VK_ROSTER_CONFIG_PATH = resolve(ROOT, 'config/vk-chat-2000000027-user-replies.json');
const MODES = new Set(['once', 'weekly', 'monthly']);
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const int = (value, fallback = 0) => Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback;
const clock = (value, fallback = '12:00') => CLOCK.test(String(value || '')) ? String(value) : fallback;
function parts(timestamp, zone) {
  const list = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(timestamp));
  const value = Object.fromEntries(list.filter((item) => item.type !== 'literal').map((item) => [item.type, item.value]));
  const weekdays = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return { ...value, weekday: weekdays[value.weekday] || 0, date: value.year + '-' + value.month + '-' + value.day, clock: value.hour + ':' + value.minute };
}
function quiet(value, policy) {
  const current = int(value.hour) * 60 + int(value.minute); const from = clock(policy?.quietHours?.from, '23:00'); const to = clock(policy?.quietHours?.to, '09:00');
  const start = int(from.slice(0, 2)) * 60 + int(from.slice(3)); const end = int(to.slice(0, 2)) * 60 + int(to.slice(3));
  return start > end ? current >= start || current < end : current >= start && current < end;
}
export function loadProactiveVkRoster(path = PROACTIVE_VK_ROSTER_CONFIG_PATH) { if (!existsSync(path)) return null; const config = JSON.parse(readFileSync(path, 'utf8')); if (!config || !Array.isArray(config.participants)) throw new TypeError('Invalid proactive VK roster config'); return config; }
export function saveProactiveVkRoster(config, path = PROACTIVE_VK_ROSTER_CONFIG_PATH) { writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf8'); }
export function buildProactiveVkMessage(participant, random = Math.random) { const list = (Array.isArray(participant?.proactive?.phrases) && participant.proactive.phrases.length ? participant.proactive.phrases : participant?.phrases || []).map((item) => String(item || '').trim()).filter(Boolean); const phrase = list.length ? list[Math.min(list.length - 1, Math.floor(random() * list.length))] : '{mention}'; const id = int(participant.userId); const name = String(participant.name || ''); const username = String(participant.username || '').replace(/^@/u, ''); const mention = id > 0 ? '[id' + id + '|' + (name || 'id' + id) + ']' : username ? '@' + username : name; return phrase.replaceAll('{name}', name).replaceAll('{username}', username).replaceAll('{mention}', mention).trim(); }
export function listDueProactiveVkParticipants(config, now = Date.now()) {
  if (!config?.proactiveEnabled) return []; const policy = config.schedulePolicy || {}; const result = [];
  for (let index = 0; index < config.participants.length; index += 1) { const participant = config.participants[index]; const item = participant?.proactive || {}; if (!item.enabled) continue; const schedule = item.schedule || {}; const mode = MODES.has(schedule.mode) ? schedule.mode : 'once'; const zone = schedule.timeZone || policy.timeZone || 'Europe/Moscow'; const current = parts(now, zone); if (quiet(current, policy)) continue; const last = int(item.lastSentAt) * 1000; if (mode === 'once') { const at = Date.parse(String(schedule.at || '')); if (Number.isFinite(at) && now >= at && last < at) result.push({ participant, index }); continue; } const expectedDay = mode === 'weekly' ? int(schedule.dayOfWeek) : int(schedule.dayOfMonth); if (mode === 'weekly' && expectedDay !== current.weekday) continue; if (mode === 'monthly' && expectedDay !== int(current.day)) continue; if (current.clock < clock(schedule.time)) continue; const lastPart = last ? parts(last, zone) : null; const sameCycle = lastPart && (mode === 'weekly' ? lastPart.date === current.date : lastPart.year === current.year && lastPart.month === current.month); if (!sameCycle) result.push({ participant, index }); } return result;
}
export function markProactiveVkParticipantSent(config, index, timestamp = Date.now()) { const participant = config?.participants?.[index]; if (participant) participant.proactive = { ...(participant.proactive || {}), lastSentAt: Math.floor(timestamp / 1000) }; return config; }
