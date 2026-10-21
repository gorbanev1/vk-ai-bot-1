import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import {
  TELEGRAM_MENU_BUTTONS,
  buildTelegramMainMenu,
  resolveTelegramMenuInput,
} from '../../src/platforms/telegram/telegramBot.js';
import {
  createPinballMiniAppServer,
  validateTelegramWebAppInitData,
} from '../../src/features/pinball/pinballServer.js';

function makeInitData(botToken, user = { id: 12345, first_name: 'Test', username: 'test_player' }) {
  const params = new URLSearchParams();
  params.set('auth_date', String(Math.floor(Date.now() / 1000)));
  params.set('query_id', 'AAEtest');
  params.set('user', JSON.stringify(user));
  const dataCheck = [...params.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', createHmac('sha256', secretKey).update(dataCheck).digest('hex'));
  return params.toString();
}

test('V139 removes Pinball from the Telegram menu and command routing', () => {
  const menu = buildTelegramMainMenu({ isOwner: true, now: new Date('2026-09-03T12:00:00Z') });
  const buttons = menu.keyboard.flat();
  assert.equal(buttons.some((button) => /пинбол/iu.test(button.text)), false);
  assert.equal(buttons.some((button) => button.text === TELEGRAM_MENU_BUTTONS.proposeEvent), true);

  const result = resolveTelegramMenuInput('пинбол', {}, { isOwner: true });
  assert.equal(result.type, 'pass');
});

test('V123 validates Telegram Mini App initData and serves game/leaderboard API', async () => {
  const botToken = '123456:TEST_TOKEN_abcdefghijklmnopqrstuvwxyz';
  const initData = makeInitData(botToken);
  assert.equal(validateTelegramWebAppInitData(initData, botToken).ok, true);
  assert.equal(validateTelegramWebAppInitData(initData, `${botToken}x`).ok, false);

  const app = createPinballMiniAppServer({ botToken, host: '127.0.0.1', port: 0, logger: { error() {} } });
  await app.start();
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}/pinball/`;
  try {
    const html = await fetch(base).then((r) => r.text());
    assert.match(html, /PINBALL PSYCHOSIS/u);
    const session = await fetch(new URL('./api/session', base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData }) }).then((r) => r.json());
    assert.ok(session.sessionToken);
    const score = await fetch(new URL('./api/score', base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionToken: session.sessionToken, score: 120000, durationMs: 12000, stats: { maxCombo: 6, maxMultiplier: 2, bumpers: 12, ramps: 2, jackpots: 0, multiballs: 0, nudges: 1 } }) }).then((r) => r.json());
    assert.equal(score.accepted, true);
    const board = await fetch(new URL('./api/leaderboard', base)).then((r) => r.json());
    assert.ok(board.rows.some((row) => row.score >= 120000));
  } finally {
    await app.stop();
  }
});
