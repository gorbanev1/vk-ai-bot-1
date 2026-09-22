import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    AI_QUOTA_QUARANTINE_START,
    cleanupConfirmedDeadKeysFromReport,
    collectQuotaExhaustedEnvNames,
    quarantineQuotaKeysFromReport,
    readQuotaQuarantinedKeys,
    recoverQuotaKeysFromLatestCleanupBackup,
} from '../../src/features/ai/envKeyCleanup.js';
import {
    AI_QUOTA_MAX_PASSES,
    applyQuotaProbeResult,
    latestQuotaRetestSlot,
    probeQuotaKeyRecovery,
    quotaKeysDueForSlot,
    registerQuotaKeys,
} from '../../src/features/ai/quotaKeyLifecycle.js';

function reportWithNoCredits() {
    return {
        workingModes: [],
        keyAudit: { results: [] },
        keySecondSweep: { results: [
            { envName: 'OPENAI_API_KEY_1', verdict: 'dead-confirmed', attempts: [
                { status: 429, error: 'You have no credits remaining. Add credits to continue using the API.' },
            ] },
            { envName: 'GROQ_API_KEY_1', verdict: 'dead-confirmed', attempts: [
                { status: 401, error: 'invalid api key' },
            ] },
        ] },
        retryCandidates: [
            { provider: 'openai', envName: 'OPENAI_API_KEY_1', status: 429, error: 'You have no credits remaining. Add credits to continue using the API.' },
        ],
    };
}

test('V144 no-credit keys are quarantined in a commented .env block and excluded from destructive cleanup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gigorave-v144-quota-env-'));
    const runtimeEnv = {
        OPENAI_API_KEY_1: 'sk-no-money',
        GROQ_API_KEY_1: 'gsk-dead',
        OPENAI_COMPAT_API_KEY: 'owner-protected',
    };
    await writeFile(join(dir, '.env'), [
        'OPENAI_COMPAT_API_KEY=owner-protected',
        'OPENAI_API_KEY_1=sk-no-money',
        'GROQ_API_KEY_1=gsk-dead',
        '',
    ].join('\n'));
    const report = reportWithNoCredits();
    try {
        assert.deepEqual(collectQuotaExhaustedEnvNames(report, runtimeEnv), ['OPENAI_API_KEY_1']);
        const quarantine = await quarantineQuotaKeysFromReport({ report, directory: dir, runtimeEnv });
        assert.deepEqual(quarantine.quarantined, ['OPENAI_API_KEY_1']);
        assert.equal(runtimeEnv.OPENAI_API_KEY_1, undefined);
        const afterQuarantine = await readFile(join(dir, '.env'), 'utf8');
        assert.match(afterQuarantine, new RegExp(AI_QUOTA_QUARANTINE_START.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
        assert.match(afterQuarantine, /# OPENAI_API_KEY_1=sk-no-money/u);
        assert.doesNotMatch(afterQuarantine, /^OPENAI_API_KEY_1=/mu);

        const cleanup = await cleanupConfirmedDeadKeysFromReport({ report, directory: dir, runtimeEnv });
        assert.deepEqual(cleanup.removed, ['GROQ_API_KEY_1']);
        const finalText = await readFile(join(dir, '.env'), 'utf8');
        assert.match(finalText, /# OPENAI_API_KEY_1=sk-no-money/u);
        assert.doesNotMatch(finalText, /^GROQ_API_KEY_1=/mu);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('V144 can recover previously deleted no-credit keys from the V142 cleanup backup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gigorave-v144-quota-recover-'));
    await writeFile(join(dir, '.env'), 'OPENAI_COMPAT_API_KEY=owner\n');
    await writeFile(join(dir, '.env.before-ai-key-cleanup-2026-09-03T13-57-51-147Z.bak'), [
        'OPENAI_COMPAT_API_KEY=owner',
        'OPENAI_API_KEY_1=sk-no-money',
        '',
    ].join('\n'));
    try {
        const recovered = await recoverQuotaKeysFromLatestCleanupBackup({
            report: reportWithNoCredits(),
            directory: dir,
            runtimeEnv: { OPENAI_COMPAT_API_KEY: 'owner' },
            now: new Date('2026-09-04T06:00:00.000Z'),
        });
        assert.deepEqual(recovered.recovered, ['OPENAI_API_KEY_1']);
        const parsed = await readQuotaQuarantinedKeys({ directory: dir });
        assert.equal(parsed.entries[0].envName, 'OPENAI_API_KEY_1');
        assert.equal(parsed.entries[0].secret, 'sk-no-money');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('V144 quota pass counter is calendar-slot based, survives restart and deletes only on the fifth confirmed quota pass', () => {
    const entry = { envName: 'OPENAI_API_KEY_1', secret: 'sk-no-money' };
    let state = registerQuotaKeys({}, [entry], { now: new Date('2026-09-04T06:00:00.000Z') });

    assert.equal(latestQuotaRetestSlot(new Date('2026-09-04T06:00:00.000Z')), '2026-08-20');
    assert.equal(quotaKeysDueForSlot(state, [entry], { now: new Date('2026-09-04T06:00:00.000Z') }).length, 0);

    const dates = [
        '2026-09-05T06:00:00.000Z',
        '2026-09-20T06:00:00.000Z',
        '2026-10-05T06:00:00.000Z',
        '2026-10-20T06:00:00.000Z',
        '2026-11-05T06:00:00.000Z',
    ];
    for (let index = 0; index < dates.length; index += 1) {
        const now = new Date(dates[index]);
        const due = quotaKeysDueForSlot(state, [entry], { now });
        assert.equal(due.length, 1);
        const applied = applyQuotaProbeResult(state, {
            envName: entry.envName,
            slotId: due[0].slotId,
            result: { status: 'quota', error: 'no credits remaining' },
            now,
        });
        state = applied.state;
        assert.equal(applied.passCount, index + 1);
        assert.equal(applied.action, index + 1 === AI_QUOTA_MAX_PASSES ? 'delete-after-five' : 'keep');

        // Simulated bot restart in the same calendar slot must not create another pass.
        assert.equal(quotaKeysDueForSlot(state, [entry], { now: new Date(now.getTime() + 60_000) }).length, 0);
    }
});

test('V144 uncertain transport failures consume the calendar slot but do not increase the quota pass counter', () => {
    const entry = { envName: 'OPENAI_API_KEY_1', secret: 'sk-no-money' };
    let state = registerQuotaKeys({}, [entry], { now: new Date('2026-09-04T06:00:00.000Z') });
    const due = quotaKeysDueForSlot(state, [entry], { now: new Date('2026-09-05T06:00:00.000Z') });
    const applied = applyQuotaProbeResult(state, {
        envName: entry.envName,
        slotId: due[0].slotId,
        result: { status: 'uncertain', error: 'network timeout' },
        now: new Date('2026-09-05T06:00:00.000Z'),
    });
    state = applied.state;
    assert.equal(applied.passCount, 0);
    assert.equal(quotaKeysDueForSlot(state, [entry], { now: new Date('2026-09-05T12:00:00.000Z') }).length, 0);
    assert.equal(quotaKeysDueForSlot(state, [entry], { now: new Date('2026-09-20T06:00:00.000Z') }).length, 1);
});

function headers(contentType = 'application/json') {
    return { get(name) { return String(name).toLowerCase() === 'content-type' ? contentType : ''; } };
}
function jsonResponse(status, payload) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: headers(),
        async text() { return JSON.stringify(payload); },
        async arrayBuffer() { return new TextEncoder().encode(JSON.stringify(payload)).buffer; },
    };
}

test('V144 quota retest recognizes a revived key with a lightweight non-stream text probe', async () => {
    const fakeFetch = async (url) => {
        const target = String(url);
        if (target.endsWith('/models')) return jsonResponse(200, { data: [{ id: 'gpt-4o-mini' }] });
        if (target.endsWith('/responses')) return jsonResponse(200, { output_text: 'GIGORAVE_AUDIT_OK' });
        if (target.endsWith('/chat/completions')) return jsonResponse(200, { choices: [{ message: { content: 'GIGORAVE_AUDIT_OK' } }] });
        return jsonResponse(404, { error: { message: 'unexpected route' } });
    };
    const result = await probeQuotaKeyRecovery({
        envName: 'OPENAI_API_KEY_1',
        secret: 'sk-revived',
        baseEnv: {},
        fetchImpl: fakeFetch,
        timeoutMs: 1_000,
    });
    assert.equal(result.status, 'working');
    assert.equal(result.recoveredMode.envName, 'OPENAI_API_KEY_1');
    assert.equal(result.recoveredMode.capability, 'text');
});
