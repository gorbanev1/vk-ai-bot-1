import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { formatPrivateError } from '../../src/shared/errors.js';
import { canPromoteLunaHealth, eligibleLunaHealthSamples, hasLunaHealthModel, lunaHealthDay, lunaHealthRate } from '../../src/features/ai/lunaHealthPolicy.js';

test('old and malformed Luna samples do not affect promotion', () => {
    const now = Date.parse('2026-10-12T12:00:00.000Z');
    const samples = [
        { version: 1, at: '2026-10-12T11:00:00.000Z', ok: true },
        { version: 2, at: '2026-10-12T11:01:00.000Z', ok: true },
        { version: 2, at: '2026-10-12T11:02:00.000Z', ok: false },
    ];
    assert.equal(eligibleLunaHealthSamples(samples, now).length, 2);
    assert.equal(lunaHealthRate(samples, now), 0.5);
    assert.equal(canPromoteLunaHealth(samples, now), false);
});

test('day report follows configured timezone and profile presence', () => {
    assert.equal(lunaHealthDay('2026-10-12T21:30:00.000Z', 'Europe/Moscow'), '2026-10-13');
    assert.equal(hasLunaHealthModel({ chat: [{ model: 'gpt-5.6-luna' }] }, 'gpt-5.6-luna'), true);
    assert.equal(hasLunaHealthModel({ chat: [{ model: 'gpt-5.6-terra' }] }, 'gpt-5.6-luna'), false);
});

test('promotion requires ten recent samples and at least 80 percent success', () => {
    const now = Date.now();
    const samples = Array.from({ length: 10 }, (_, index) => ({ version: 2, at: new Date(now).toISOString(), ok: index < 8 }));
    assert.equal(canPromoteLunaHealth(samples, now), true);
    assert.equal(canPromoteLunaHealth(samples.slice(0, 9), now), false);
    samples[0].ok = false;
    assert.equal(canPromoteLunaHealth(samples, now), false);
});

test('a failed real probe handler persists failure instead of throwing error.slice', async () => {
    const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const start = app.indexOf('async function runGpt6LunaHealthProbe(');
    const end = app.indexOf('function gpt6LunaHealthLocalParts(', start);
    let saved;
    const run = vm.runInNewContext(app.slice(start, end) + '\nrunGpt6LunaHealthProbe', {
        GPT6_LUNA_MODEL_ID: 'gpt-6-luna', LUNA_HEALTH_SAMPLE_VERSION: 2, formatPrivateError,
        generateOpenAITextCoreAttempt: async () => { throw Object.assign(new Error('HTTP 503'), { status: 503 }); },
        readGpt6LunaHealth: () => ({ samples: [], promoted: false }),
        gpt6LunaHealthRate: state => lunaHealthRate(state.samples), canPromoteLunaHealth,
        writeGpt6LunaHealth: state => { saved = state; },
    });
    const result = await run('text');
    assert.equal(result.ok, false);
    assert.equal(saved.samples.length, 1);
    assert.equal(saved.samples[0].ok, false);
    assert.equal(saved.samples[0].version, 2);
    assert.match(saved.samples[0].error, /503/);
});
