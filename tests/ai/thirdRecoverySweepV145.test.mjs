import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    buildThirdRecoveryModelCandidates,
    collectThirdRecoveryLateModes,
    runThirdRecoverySweep,
} from '../../src/features/ai/thirdRecoverySweep.js';

function headers(contentType = 'application/json') {
    return { get(name) { return String(name).toLowerCase() === 'content-type' ? contentType : ''; } };
}

function response(status, payload, contentType = 'application/json') {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: headers(contentType),
        async text() { return body; },
        async arrayBuffer() { return new TextEncoder().encode(body).buffer; },
    };
}

function uncertainReport(outDir) {
    return {
        checkedAt: '2026-09-03T12:51:51.200Z',
        outDir,
        keySecondSweep: {
            results: [{
                provider: 'openai',
                envName: 'OPENAI_API_KEY_1',
                masked: 'sk-test…00001',
                verdict: 'uncertain',
                attempts: [
                    { capability: 'text', model: 'gpt-4o', transport: 'non_stream', status: 0, error: 'socket timeout' },
                    { capability: 'text', model: 'gpt-4o', transport: 'stream', status: 503, error: 'upstream unavailable' },
                ],
            }],
            recoveredModes: [],
        },
        textResults: [],
        imageResults: [],
        workingModes: [],
    };
}

test('V145 third sweep only samples the strongest candidates for an uncertain key', () => {
    const candidates = buildThirdRecoveryModelCandidates({
        sweepRow: {
            provider: 'openai',
            attempts: [
                { capability: 'text', model: 'old-model', status: 404, error: 'not found' },
                { capability: 'text', model: 'gpt-4o', status: 0, error: 'timeout' },
                { capability: 'text', model: 'gpt-5', status: 503, error: 'server' },
                { capability: 'image', model: 'gpt-image-1', status: 0, error: 'timeout' },
            ],
        },
        liveModels: [{ id: 'gpt-4o', capabilities: ['text'] }, { id: 'gpt-image-1', capabilities: ['image'] }],
        textLimit: 1,
        imageLimit: 1,
    });
    assert.equal(candidates.length, 2);
    assert.equal(candidates.filter((row) => row.capability === 'text').length, 1);
    assert.equal(candidates.filter((row) => row.capability === 'image').length, 1);
    assert.equal(candidates.find((row) => row.capability === 'image').model, 'gpt-image-1');
});

test('V145 identifies modes that only recovered on late retry rounds', () => {
    const report = {
        keySecondSweep: { recoveredModes: [] },
        textResults: [{
            provider: 'openai', envName: 'OPENAI_API_KEY_1', model: 'gpt-4o', capability: 'text', keep: true,
            transports: {
                non_stream: { ok: true, firstRound: { ok: false }, secondRound: { ok: true } },
                stream: { ok: false, firstRound: { ok: false }, secondRound: { ok: false } },
            },
        }],
        imageResults: [],
        workingModes: [{ provider: 'openai', envName: 'OPENAI_API_KEY_1', model: 'gpt-4o', capability: 'text' }],
    };
    const rows = collectThirdRecoveryLateModes(report);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].model, 'gpt-4o');
});

test('V145 third sweep recovers an uncertain key without repeating the whole catalog and is restart-idempotent after DONE', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gigorave-v145-third-'));
    const report = uncertainReport(dir);
    const env = { OPENAI_API_KEY_1: 'sk-test-key' };
    let calls = 0;
    const fakeFetch = async (url) => {
        calls += 1;
        const target = String(url);
        if (target.endsWith('/models')) return response(200, { data: [{ id: 'gpt-4o' }] });
        if (target.endsWith('/responses')) return response(200, { output_text: 'GIGORAVE_AUDIT_OK' });
        return response(404, { error: { message: 'unexpected route' } });
    };
    try {
        const first = await runThirdRecoverySweep({
            report,
            sourceOutDir: dir,
            env,
            directory: dir,
            fetchImpl: fakeFetch,
            force: true,
        });
        assert.equal(first.stats.recoveredModes, 1);
        assert.equal(first.stats.recoveredKeys, 1);
        assert.equal(first.updatedWorkingModes.length, 1);
        const callsAfterFirst = calls;

        const second = await runThirdRecoverySweep({
            report,
            sourceOutDir: dir,
            env,
            directory: dir,
            fetchImpl: async () => { throw new Error('must not be called after completed DONE'); },
        });
        assert.equal(second.resumedCompleted, true);
        assert.equal(calls, callsAfterFirst);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('V145 treats no-credit 429 as quota quarantine, not as an invalid key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gigorave-v145-quota-'));
    const report = uncertainReport(dir);
    const env = { OPENAI_API_KEY_1: 'sk-no-money' };
    const fakeFetch = async (url) => {
        const target = String(url);
        if (target.endsWith('/models')) return response(200, { data: [{ id: 'gpt-4o' }] });
        if (target.endsWith('/responses')) return response(429, { error: { message: 'You have no credits remaining. Add credits to continue using the API.' } });
        return response(404, { error: { message: 'unexpected route' } });
    };
    try {
        const sweep = await runThirdRecoverySweep({
            report,
            sourceOutDir: dir,
            env,
            directory: dir,
            fetchImpl: fakeFetch,
            force: true,
        });
        assert.deepEqual(sweep.quotaEnvNames, ['OPENAI_API_KEY_1']);
        assert.deepEqual(sweep.invalidEnvNames, []);
        assert.equal(sweep.stats.recoveredModes, 0);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

import { parseProviderCommand } from '../../src/features/ai/providerDiagnostics.js';

test('V145 owner command routes the third/final recovery sweep before generic GPT', () => {
    assert.equal(parseProviderCommand('третий обход моделей').action, 'third_recovery_sweep');
    assert.equal(parseProviderCommand('3й проход апи').action, 'third_recovery_sweep');
    assert.equal(parseProviderCommand('финальный обход ключей').action, 'third_recovery_sweep');
});

test('V145 stops hammering an exact key after rate-limit 429 and keeps it for later', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gigorave-v145-rate-limit-'));
    const report = uncertainReport(dir);
    report.keySecondSweep.results[0].attempts.push(
        { capability: 'text', model: 'gpt-5', transport: 'non_stream', status: 0, error: 'timeout' },
    );
    const env = { OPENAI_API_KEY_1: 'sk-rate-limited' };
    const calls = [];
    const fakeFetch = async (url) => {
        const target = String(url);
        calls.push(target);
        if (target.endsWith('/models')) return response(200, { data: [{ id: 'gpt-4o' }, { id: 'gpt-5' }] });
        if (target.endsWith('/responses')) return response(429, { error: { message: 'Rate limit reached for requests per minute' } });
        return response(429, { error: { message: 'Rate limit reached' } });
    };
    try {
        const sweep = await runThirdRecoverySweep({ report, sourceOutDir: dir, env, directory: dir, fetchImpl: fakeFetch, force: true });
        assert.deepEqual(sweep.rateLimitedEnvNames, ['OPENAI_API_KEY_1']);
        assert.equal(sweep.uncertainModelResults.length, 1);
        assert.equal(calls.filter((url) => url.endsWith('/responses')).length, 1);
        assert.deepEqual(sweep.quotaEnvNames, []);
        assert.deepEqual(sweep.invalidEnvNames, []);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
