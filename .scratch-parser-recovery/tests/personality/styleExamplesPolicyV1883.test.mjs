import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const store = readFileSync(new URL('../../src/infrastructure/database/personalizationStateStore.js', import.meta.url), 'utf8');

assert.match(store, /CREATE TABLE IF NOT EXISTS communication_style_examples/u);
assert.match(app, /saveCommunicationStyleExamples/u);
assert.match(app, /getCommunicationStyleExamples/u);
assert.match(app, /Реальные примеры речи этого участника/u);
assert.match(app, /По умолчанию отвечай как обычный человек в чате: одно короткое предложение/u);
assert.match(app, /По умолчанию лучше одно короткое предложение/u);
console.log('styleExamplesPolicyV1883: ok');
