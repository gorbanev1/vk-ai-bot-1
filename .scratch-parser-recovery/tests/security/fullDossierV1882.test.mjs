import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolveCommandPriority } from '../../src/features/routing/commandPriorityRouting.js';

const source = readFileSync(
    new URL('../../src/app/botApplication.js', import.meta.url),
    'utf8',
);

test('V188.2 routes full dossier as the local dossier command', () => {
    assert.equal(resolveCommandPriority('полное досье Максим Крылов').route, 'dossier');
    assert.equal(resolveCommandPriority('досье Максим Крылов').route, 'dossier');
});

test('V188.2 full dossier has four-times output cap and durable render cache', () => {
    assert.match(source, /const DOSSIER_FULL_OUTPUT_MAX_CHARS = DOSSIER_OUTPUT_MAX_CHARS \* 4;/u);
    assert.match(source, /async function renderFullDossier\(/u);
    assert.match(source, /getDossierRenderCache\(peerId, userId, 'full', inputHash\)/u);
    assert.match(source, /saveDossierRenderCache\(\{/u);
    assert.match(source, /maxTokens: 3600/u);
    assert.match(source, /await sendLong\(context, fullPortrait\.text\)/u);
});

test('V188.2 strips full dossier prefix before target resolution', () => {
    assert.match(source, /replace\(\/\^\\s\*\(\?:полное\\s\+\)\?досье/u);
});
