import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const streamSource = readFileSync(new URL('../../src/features/ai/openAIStream.js', import.meta.url), 'utf8');

test('V159 prashna is forced to SSE and cannot silently fall back to non-stream', () => {
  assert.match(appSource, /forceStream:\s*prashnaRequest/u);
  assert.match(appSource, /requireStream:\s*prashnaRequest/u);
  assert.match(appSource, /disableRecovery:\s*prashnaRequest/u);
  assert.match(appSource, /policy=forced-prashna-stream/u);
  assert.match(appSource, /GPT STREAM REQUIRED/u);
});

test('V159 prashna has visible live delivery and watchdogs', () => {
  assert.match(appSource, /createPrashnaLiveStreamRelay/u);
  assert.match(appSource, /PRASHNA_STREAM_HEADER_TIMEOUT_MS/u);
  assert.match(appSource, /PRASHNA_STREAM_IDLE_TIMEOUT_MS/u);
  assert.match(appSource, /PRASHNA_STREAM_FIRST_TEXT_TIMEOUT_MS/u);
  assert.match(appSource, /PRASHNA LIVE STREAM COMPLETE/u);
  assert.match(appSource, /Ошибка потока прашны/u);
  assert.match(streamSource, /STREAM IDLE TIMEOUT/u);
});
