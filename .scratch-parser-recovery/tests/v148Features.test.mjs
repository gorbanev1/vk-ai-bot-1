import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/app/botApplication.js', import.meta.url), 'utf8');
const db = readFileSync(new URL('../src/infrastructure/database/index.js', import.meta.url), 'utf8');
const telegram = readFileSync(new URL('../src/platforms/telegram/telegramBot.js', import.meta.url), 'utf8');
const dedupe = readFileSync(new URL('../src/features/events/eventDuplicateResolution.js', import.meta.url), 'utf8');

assert.match(telegram, /🚀 Продвинутые текстовые модели GPT/u);
assert.doesNotMatch(telegram, /🚀 Продвинутые модели['"]/u);

assert.match(app, /тусы\\s\+дубли\\s\+статус/u);
assert.match(app, /scanCurrentDatabaseWithFastEventDedupe/u);
assert.match(app, /точные название\+дата решаю локально/u);
assert.match(app, /EVENT_DEDUPE_AUDIT_TASK_KEY/u);
assert.match(app, /process-restarted/u);
assert.match(dedupe, /const keyPosting = new Map\(\)/u);
assert.match(dedupe, /Sparse-карточка без даты/u);

assert.match(db, /CREATE TABLE IF NOT EXISTS bot_request_events/u);
assert.match(db, /export function recordBotRequestEvent/u);
assert.match(db, /export function getBotRequestStats/u);
assert.match(app, /parseBotRequestStatsCommand/u);
assert.match(app, /обращения сегодня/u);
assert.match(app, /за прошлые/u);
assert.match(app, /BOT_REQUEST_STATS_SLOTS = Object\.freeze\(\['18:00', '21:00'\]\)/u);
assert.match(app, /BOT_REQUEST_STATS_TASK_KEY/u);

assert.match(app, /досье никогда не обновляется/iu);
assert.match(app, /\[FACTS\]/u);
assert.match(app, /\[PORTRAIT\]/u);
assert.match(app, /Не ставь медицинские\/психиатрические диагнозы/u);
assert.match(app, /сексуальной ориентации, религии, политических взглядах или преступности/u);
assert.match(app, /DOSSIER_COMMAND_BATCH_MESSAGES/u);

console.log('V148 feature regression checks: OK');
