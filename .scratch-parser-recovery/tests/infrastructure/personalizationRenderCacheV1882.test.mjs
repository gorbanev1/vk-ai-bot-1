import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPersonalizationStateStore } from '../../src/infrastructure/database/personalizationStateStore.js';

test('V188.2 full dossier render cache is keyed by input hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gigorave-v1882-render-cache-'));
    const store = createPersonalizationStateStore({ directory: dir });
    try {
        store.saveDossierRenderCache({
            peerId: 2000000006,
            userId: 123,
            variant: 'full',
            inputHash: 'hash-a',
            portraitText: 'cached full dossier',
            updatedAt: 123456,
        });
        assert.equal(
            store.getDossierRenderCache(2000000006, 123, 'full', 'hash-a')?.portraitText,
            'cached full dossier',
        );
        assert.equal(store.getDossierRenderCache(2000000006, 123, 'full', 'hash-b'), null);
    } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
