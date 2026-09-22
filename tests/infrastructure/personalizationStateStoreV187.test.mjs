import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createPersonalizationStateStore } from '../../src/infrastructure/database/personalizationStateStore.js';

test('V187 durable style checkpoint survives store reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gigorave-v187-style-'));
    const dbPath = join(dir, 'state.sqlite');
    try {
        const first = createPersonalizationStateStore({ databasePath: dbPath });
        first.saveStyleState({
            peerId: 10,
            userId: 20,
            lastCreatedAt: 1000,
            lastConversationMessageId: 77,
            processedMessageCount: 500,
            styleText: 'коротко и по делу',
        });
        first.close();

        const second = createPersonalizationStateStore({ databasePath: dbPath });
        assert.deepEqual(second.getStyleState(10, 20), {
            peerId: 10,
            userId: 20,
            lastCreatedAt: 1000,
            lastConversationMessageId: 77,
            processedMessageCount: 500,
            styleText: 'коротко и по делу',
            updatedAt: second.getStyleState(10, 20).updatedAt,
        });
        second.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('V187 dossier command state stores paid-batch cursor and accumulated result', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gigorave-v187-dossier-'));
    const dbPath = join(dir, 'state.sqlite');
    try {
        const store = createPersonalizationStateStore({ databasePath: dbPath });
        store.saveDossierState({
            peerId: 1,
            userId: 2,
            lastCreatedAt: 2000,
            lastConversationMessageId: 88,
            processedMessageCount: 400,
            facts: [{ rating: 3, fact: 'Любит короткие ответы' }],
            portraitText: 'ДОСЬЕ\nКоротко: предпочитает лаконичность.',
        });
        const state = store.getDossierState(1, 2);
        assert.equal(state.processedMessageCount, 400);
        assert.equal(state.lastCreatedAt, 2000);
        assert.equal(state.lastConversationMessageId, 88);
        assert.deepEqual(state.facts, [{ rating: 3, fact: 'Любит короткие ответы' }]);
        assert.match(state.portraitText, /ДОСЬЕ/u);
        store.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
