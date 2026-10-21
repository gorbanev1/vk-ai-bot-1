import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    parseDossierCommand,
    resolveCommandPriority,
} from '../../src/features/routing/commandPriorityRouting.js';

const appSource = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

test('V188.40 dossier routing is independent of word order', () => {
    const cases = [
        ['досье Константин Царапкин', 'досье Константин Царапкин'],
        ['Константин Царапкин досье', 'досье Константин Царапкин'],
        ['Гигорейв Константин Царапкин досье', 'досье Константин Царапкин'],
        ['досье на Константин Царапкин', 'досье Константин Царапкин'],
        ['Константин Царапкин полное досье', 'полное досье Константин Царапкин'],
    ];

    for (const [input, canonical] of cases) {
        const parsed = parseDossierCommand(input);
        assert.equal(parsed.matched, true, input);
        assert.equal(parsed.commandText, canonical, input);
        const routed = resolveCommandPriority(input);
        assert.equal(routed.route, 'dossier', input);
        assert.equal(routed.selected.commandText, canonical, input);
    }
});

test('V188.40 compact dossier uses a dedicated ~2k final render and versioned cache', () => {
    assert.match(appSource, /const DOSSIER_OUTPUT_MIN_CHARS = 1800;/u);
    assert.match(appSource, /const DOSSIER_OUTPUT_TARGET_CHARS = 2000;/u);
    assert.match(appSource, /const DOSSIER_OUTPUT_MAX_CHARS = 2200;/u);
    assert.match(appSource, /async function renderCompactDossier\(/u);
    assert.match(appSource, /'compact-v18840'/u);
    assert.match(appSource, /\[DOSSIER COMPACT COMPLETE\]/u);
    assert.match(appSource, /Целевой объём — около \$\{DOSSIER_OUTPUT_TARGET_CHARS\} символов/u);
});
