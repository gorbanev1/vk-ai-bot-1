import assert from 'node:assert/strict';
import test from 'node:test';
import { createImagePromptBatcher, fitImagePromptForModel, imagePromptBatchKey } from '../../src/features/ai/imagePromptBatcher.js';

test('image prompt batcher joins parts after quiet period', async () => {
  const flushed = [];
  const batcher = createImagePromptBatcher({ delayMs: 20, onFlush: value => { flushed.push(value); return value; } });
  const key = imagePromptBatchKey({ platform: 'telegram', peerId: 10, senderId: 5 });
  assert.equal(batcher.enqueue({ key, text: 'ночной город', context: { id: 1 } }).first, true);
  assert.equal(batcher.enqueue({ key, text: 'мокрый асфальт', context: { id: 2 } }).count, 2);
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].text, 'ночной город\n\nмокрый асфальт');
  assert.equal(batcher.size(), 0);
});

test('image prompt batcher isolates platform, chat and sender', async () => {
  const flushed = [];
  const batcher = createImagePromptBatcher({ delayMs: 5, onFlush: value => { flushed.push(value); } });
  const a = imagePromptBatchKey({ platform: 'telegram', peerId: 1, senderId: 7 });
  const b = imagePromptBatchKey({ platform: 'telegram', peerId: 1, senderId: 8 });
  batcher.enqueue({ key: a, text: 'A' });
  batcher.enqueue({ key: b, text: 'B' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(flushed.map(item => item.text).sort(), ['A', 'B']);
});

test('image prompt batcher can cancel without flushing', async () => {
  let flushed = 0;
  const batcher = createImagePromptBatcher({ delayMs: 5, onFlush: () => { flushed += 1; } });
  const key = 'telegram:1:1';
  batcher.enqueue({ key, text: 'cancel me' });
  assert.equal(batcher.cancel(key), true);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(flushed, 0);
});

test('an oversized first prompt is kept intact and does not dispatch immediately', async () => {
  const flushed = [];
  const batcher = createImagePromptBatcher({ maxCharacters: 4, delayMs: 10, onFlush: value => { flushed.push(value); } });
  const result = batcher.enqueue({ key: 'telegram:1:1', text: 'long prompt', context: { hasAttachment: false } });
  assert.equal(result.queued, true);
  assert.equal(result.count, 1);
  assert.equal(batcher.has('telegram:1:1'), true);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].text, 'long prompt');
});

test('long image prompts are summarized before generation', async () => {
  let received = '';
  const result = await fitImagePromptForModel({
    text: 'a'.repeat(20),
    maxCharacters: 10,
    summarize: async source => { received = source; return 'a concise prompt'; },
  });
  assert.equal(received.length, 20);
  assert.equal(result.text, 'a concise prompt');
  assert.equal(result.compressed, true);
  assert.equal(result.originalCharacters, 20);
});

test('oversized prompt summary failures are propagated instead of sending the raw prompt', async () => {
  await assert.rejects(
    fitImagePromptForModel({ text: 'a'.repeat(20), maxCharacters: 10, summarize: async () => { throw new Error('summary failed'); } }),
    /summary failed/u,
  );
});
