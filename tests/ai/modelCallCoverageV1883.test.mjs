import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const external = readFileSync(new URL('../../src/features/ai/externalProviderRouting.js', import.meta.url), 'utf8');
const voice = readFileSync(new URL('../../src/features/ai/voiceTranscription.js', import.meta.url), 'utf8');
const nvidia = readFileSync(new URL('../../src/features/ai/nvidiaVisualGeneration.js', import.meta.url), 'utf8');

assert.match(app, /async function generateOpenAIText[\s\S]*?executeBotModelFailover/u);
assert.match(app, /async function generateOpenAIVisionText[\s\S]*?executeBotModelFailover/u);
assert.match(app, /async function generateOpenAIImage[\s\S]*?executeBotModelFailover/u);
assert.match(app, /async function generateText[\s\S]*?executeRuntimeModelFailover/u);
assert.match(external, /runExternalProviderChat[\s\S]*?executeRuntimeModelFailover/u);
assert.match(voice, /transcribeAudioBuffer[\s\S]*?executeRuntimeModelFailover/u);
assert.match(nvidia, /generateNvidiaVisualImage[\s\S]*?executeRuntimeModelFailover/u);

console.log('modelCallCoverageV1883: ok');
