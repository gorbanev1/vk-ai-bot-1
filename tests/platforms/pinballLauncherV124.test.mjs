import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../../miniapps/pinball/pinball.js', import.meta.url), 'utf8');

test('V124 regression: shooter lane is not blocked by the old crossing wall', () => {
  assert.doesNotMatch(source, /segment\(830,\s*1240,\s*730,\s*1370/u, 'V123 wall crossed the launcher lane');
});

test('V124 regression: a served ball has a deterministic way to enter the playfield', () => {
  const legacyDeterministicExit = /shooterExitArmed/u.test(source) && /b\.vx\s*=\s*Math\.min/u.test(source);
  const guidedShooterRail = (/SHOOTER_PATH/u.test(source) && /updateShooterPath/u.test(source)) || (/SHOOTER_TRACK/u.test(source) && /updateShooterMotion/u.test(source));
  assert.equal(legacyDeterministicExit || guidedShooterRail, true);
});

test('V124 regression: ordinary blur does not force the game into pause', () => {
  const blurLine = source.split('\n').find((line) => line.includes("window.addEventListener('blur'")) || '';
  assert.ok(blurLine);
  assert.doesNotMatch(blurLine, /togglePause/u);
});
