import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(
    path.resolve(here, '../../src/app/botApplication.js'),
    'utf8',
);

assert.doesNotMatch(source, /const activeCommunicationQueues = new Map\(\)/u);
assert.match(source, /ACTIVE_COMMUNICATION_AI_TIMEOUT_MS = 25 \* 1000/u);
assert.match(source, /ACTIVE_COMMUNICATION_SEND_TIMEOUT_MS = 15 \* 1000/u);
assert.match(source, /scheduleActiveCommunicationReply\(context, incomingText, behaviorEpoch\)/u);
assert.match(source, /buildActiveCommunicationModelModeChain\(preferredMode\)/u);
assert.match(source, /requestTimeoutMs: ACTIVE_COMMUNICATION_AI_TIMEOUT_MS/u);
assert.match(source, /mode: 'gigachat-fallback'/u);
assert.match(source, /\[ACTIVE COMMUNICATION WATCHDOG\]/u);
assert.match(source, /\[ACTIVE COMMUNICATION COMMAND FASTPATH\]/u);

console.log('active communication runtime tests passed');
