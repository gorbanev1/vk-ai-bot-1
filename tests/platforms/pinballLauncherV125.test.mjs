import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const js = await readFile(new URL('../../miniapps/pinball/pinball.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../../miniapps/pinball/index.html', import.meta.url), 'utf8');
const server = await readFile(new URL('../../src/features/pinball/pinballServer.js', import.meta.url), 'utf8');

test('V125+ keeps launch on a guided shooter rail instead of collision-dependent free flight', () => {
  const v125Rail = /const SHOOTER_PATH = Object\.freeze/u.test(js) && /function updateShooterPath\(ball, t\)/u.test(js);
  const v126Rail = /const SHOOTER_TRACK/u.test(js) && /function updateShooterMotion\(ball, dt\)/u.test(js);
  assert.equal(v125Rail || v126Rail, true);
  assert.doesNotMatch(js, /shooterExitArmed/u);
});

test('V125+ shooter rail ends inside the live playfield', () => {
  const oldExit = /p3: Object\.freeze\(\{ x: 690, y: 245 \}\)/u.test(js);
  const newExit = /Object\.freeze\(\{ x:585, y:350 \}\)/u.test(js);
  assert.equal(oldExit || newExit, true);
});

test('V125+ does not create automatic pause screens on focus/visibility/Telegram deactivation', () => {
  const visibilityLine = js.split('\n').find((line) => line.includes("document.addEventListener('visibilitychange'")) || '';
  const deactivatedLine = js.split('\n').find((line) => line.includes("tg?.onEvent?.('deactivated'")) || '';
  assert.ok(visibilityLine);
  assert.ok(deactivatedLine);
  assert.doesNotMatch(visibilityLine, /togglePause/u);
  assert.doesNotMatch(deactivatedLine, /togglePause/u);
  assert.match(js, /releaseHeldControls\(\{ launch: true \}\)/u);
});

test('V125+ has keyboard, pointer and click launch fallbacks', () => {
  assert.match(js, /if\(k===' '\|\|k==='arrowdown'\).*state\.launchHeldAt=now\(\)/u);
  assert.match(js, /if\(controls\.launch\)launchBall\(\)/u);
  assert.match(js, /if\(name==='launch'\)el\.addEventListener\('click'/u);
});

test('V125+ disables browser cache for Mini App assets', () => {
  assert.match(html, /pinball\.css\?v=12[5-9]/u);
  assert.match(html, /pinball\.js\?v=12[5-9]/u);
  assert.match(server, /'cache-control': 'no-store, max-age=0'/u);
  assert.match(server, /'pragma': 'no-cache'/u);
});
