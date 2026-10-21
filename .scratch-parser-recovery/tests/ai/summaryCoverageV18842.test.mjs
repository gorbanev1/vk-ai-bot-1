import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHierarchicalSummaryStateStore } from '../../src/infrastructure/database/hierarchicalSummaryStateStore.js';

test('V188.42 hierarchy message coverage is immutable once paid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gigorave-v18842-'));
  const store = createHierarchicalSummaryStateStore({ directory: dir });
  try {
    store.saveMessageState({
      messageKey: '2000000022:5040', peerId: 2000000022,
      contentHash: 'hash-original', nodeKey: 'leaf-original', sourcePeerId: 2000000022,
      conversationMessageId: 5040, createdAt: 123,
    });
    store.saveMessageState({
      messageKey: '2000000022:5040', peerId: 2000000022,
      contentHash: 'hash-edited', nodeKey: 'leaf-new', sourcePeerId: 2000000022,
      conversationMessageId: 5040, createdAt: 124,
    });
    const state = store.getMessageState('2000000022:5040');
    assert.equal(state.contentHash, 'hash-original');
    assert.equal(state.nodeKey, 'leaf-original');
    assert.equal(state.createdAt, 123);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('V188.42 summary scan never requeues an existing message key on content hash change', () => {
  const source = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
  assert.match(source, /if \(messageStateByKey\.has\(messageKey\)\) return false;/u);
  assert.match(source, /recoveredMessageCanAliasPaidState\(message, paidStates\)/u);
  assert.doesNotMatch(source, /!state \|\| state\.contentHash !== hierarchyMessageContentHash\(message\)/u);
});
