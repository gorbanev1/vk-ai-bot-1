import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonalizationStateStore } from '../../src/infrastructure/database/personalizationStateStore.js';

const dir = mkdtempSync(join(tmpdir(), 'gigorave-style-examples-'));
try {
    const store = createPersonalizationStateStore({ databasePath: join(dir, 'state.sqlite') });
    store.saveStyleExamples({
        peerId: 2000000006,
        userId: 123,
        maxStored: 8,
        examples: Array.from({ length: 12 }, (_, index) => ({
            createdAt: 1000 + index,
            conversationMessageId: 200 + index,
            text: `реплика ${index}`,
        })),
    });
    const rows = store.getStyleExamples(2000000006, 123, 20);
    assert.equal(rows.length, 8);
    assert.equal(rows[0].text, 'реплика 11');
    assert.equal(rows.at(-1).text, 'реплика 4');
    store.close();
} finally {
    rmSync(dir, { recursive: true, force: true });
}
console.log('personalizationStyleExamplesV1883: ok');
