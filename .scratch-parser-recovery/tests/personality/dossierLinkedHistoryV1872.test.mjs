import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const dbSource = readFileSync(new URL('../../src/infrastructure/database/index.js', import.meta.url), 'utf8');

test('V187.2 dossier includes linked VK archive history instead of messages table only', () => {
    assert.match(source, /getVkMessageArchiveUserMessages/u);
    assert.match(source, /mergeDossierStoredMessages/u);
    assert.match(source, /\[DOSSIER HISTORY SOURCES\]/u);
    assert.match(dbSource, /WHERE peer_id = \?\s+AND sender_id = \?/u);
    assert.match(dbSource, /source_peer_id/u);
});

test('V187.2 participant resolution includes archive-only users', () => {
    assert.match(source, /getVkMessageArchiveParticipantIds/u);
    assert.match(source, /for \(const userId of archiveParticipantIds\)/u);
});

test('V187.2 dossier checkpoints each physical source peer separately', () => {
    assert.match(source, /getDossierSourceStates/u);
    assert.match(source, /saveDossierSourceState/u);
    assert.match(source, /sourceStateByPeer/u);
    assert.match(source, /V187 had one cursor for the current peer only/u);
});
