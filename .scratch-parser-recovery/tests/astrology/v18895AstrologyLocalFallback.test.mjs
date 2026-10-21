import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveAstrologyExecution } from '../../src/features/astrology/astrologyRouting.js';
import {
    buildSwissEphemerisModelFallbackPrompt,
    prepareLocalSwissEphemerisRuntime,
} from '../../src/features/astrology/astrologyRuntimeFallback.js';

test('V188.95: ordinary prashna without explicit model/local token is local-first', () => {
    const result = resolveAstrologyExecution({ kind: 'prashna', mode: 'default' });
    assert.equal(result.localCalculation, true);
    assert.equal(result.packet, 'maximum');
    assert.equal(result.modelCalculation, false);
    assert.equal(result.modelFallbackAllowed, true);
});

test('V188.95: pro prashna is also local-first, model is interpreter only', () => {
    const result = resolveAstrologyExecution({ kind: 'prashna', mode: 'pro3' });
    assert.equal(result.localCalculation, true);
    assert.equal(result.packet, 'maximum');
    assert.equal(result.modelFallbackAllowed, true);
});

test('V188.95: local runtime autodiscovers complete project data/swisseph set', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gigorave-sweph-'));
    const ephe = join(cwd, 'data', 'swisseph');
    mkdirSync(ephe, { recursive: true });
    for (const name of ['sepl_18.se1', 'semo_18.se1', 'seas_18.se1']) {
        writeFileSync(join(ephe, name), 'test');
    }
    const env = {};
    const result = prepareLocalSwissEphemerisRuntime({ env, cwd });
    assert.equal(result.ready, true);
    assert.equal(env.EPHEMERIS_PATH, ephe);
});

test('V188.95: model fallback explicitly requires real Swiss Ephemeris/install', () => {
    const prompt = buildSwissEphemerisModelFallbackPrompt({
        kind: 'prashna',
        error: new Error('EPHEMERIS_PATH not configured'),
        calculationDate: new Date('2026-09-18T07:00:00.000Z'),
        location: { name: 'Voronezh', latitude: 51.67, longitude: 39.18 },
        timeZone: 'Europe/Moscow',
    });
    assert.match(prompt, /FALLBACK_SWISS_EPHEMERIS_REQUIRED/u);
    assert.match(prompt, /sweph@2\.10\.3-7/u);
    assert.match(prompt, /установи .+npm\/pnpm/iu);
    assert.match(prompt, /не .+по памяти/iu);
    assert.match(prompt, /EPHEMERIS_PATH/u);
});
