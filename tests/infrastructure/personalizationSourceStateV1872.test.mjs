import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createPersonalizationStateStore } from '../../src/infrastructure/database/personalizationStateStore.js';

test('V187.2 stores independent dossier cursors for linked source peers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gigorave-v1872-dossier-source-'));
    try {
        const store = createPersonalizationStateStore({ databasePath: join(dir, 'state.sqlite') });
        store.saveDossierSourceState({ peerId: 2000000006, userId: 42, sourcePeerId: 2000000006, lastCreatedAt: 2000, lastConversationMessageId: 9, processedMessageCount: 7 });
        store.saveDossierSourceState({ peerId: 2000000006, userId: 42, sourcePeerId: 2000000002, lastCreatedAt: 1000, lastConversationMessageId: 777, processedMessageCount: 350 });
        const states = store.getDossierSourceStates(2000000006, 42);
        assert.equal(states.length, 2);
        assert.equal(states.find((item) => item.sourcePeerId === 2000000006)?.processedMessageCount, 7);
        assert.equal(states.find((item) => item.sourcePeerId === 2000000002)?.processedMessageCount, 350);
        store.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
