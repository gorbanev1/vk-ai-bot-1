import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runManualParserPoolUntilSettled } from '../../src/features/scrapers/manualProcessingPool.js';

const exhausted = [];
const unresolved = await runManualParserPoolUntilSettled(
    [{ id: 1 }],
    async () => ({ unresolved: true }),
    {
        concurrency: 1,
        maxRetryCycles: 1,
        maxRetryElapsedMs: 60_000,
        onRetryExhausted: (event) => exhausted.push(event),
    },
);
assert.equal(unresolved.length, 1);
assert.equal(unresolved[0].status, 'rejected');
assert.equal(unresolved[0].reason?.code, 'MANUAL_PARSER_RETRY_EXHAUSTED');
assert.equal(exhausted.length, 1);
assert.equal(exhausted[0].pendingCount, 1);
assert.match(exhausted[0].reason, /retry-cycle-limit-1/u);

const retryFailure = await runManualParserPoolUntilSettled(
    [{ id: 2 }],
    async () => { throw new Error('AI timeout'); },
    {
        concurrency: 1,
        maxRetryCycles: 1,
        maxRetryElapsedMs: 60_000,
        isRetryableFailure: () => true,
    },
);
assert.equal(retryFailure[0].status, 'rejected');
assert.match(retryFailure[0].reason?.message || '', /AI timeout/u);

const app = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
assert.match(app, /EVENT_PARSER_AI_ATTEMPT_TIMEOUT_MS\s*=\s*clampInteger\([\s\S]*?180_000,[\s\S]*?75_000,/u);
assert.match(app, /events-v18854-parser-ladder-audit/u);

const routing = await readFile(new URL('../../src/features/personality/activeCommunicationRouting.js', import.meta.url), 'utf8');
assert.match(routing, /return \['default', 'gpt54', 'gpt55', 'pro', 'pro2', 'pro3'\];/u);
