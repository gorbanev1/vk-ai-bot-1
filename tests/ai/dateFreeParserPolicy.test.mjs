import test from 'node:test';
import assert from 'node:assert/strict';
import { createDateFreeParserPolicy, createParserAttemptPacer } from '../../src/features/ai/dateFreeParserPolicy.js';

test('four Luna failures allow a successful Terra attempt', async () => {
    const policy = createDateFreeParserPolicy();
    for (let i = 0; i < 8; i++) await policy.run('text', async () => 'ok');
    const attempts = [];
    assert.equal(await policy.run('vision', async (model) => {
        attempts.push(model);
        if (model === 'gpt-5.6-luna') throw new Error('503');
        return 'facts';
    }), 'facts');
    assert.deepEqual(attempts, [...Array(4).fill('gpt-5.6-luna'), 'gpt-5.6-terra']);
    assert.equal(policy.snapshot().models['gpt-5.6-luna'].failures, 4);
});

test('exhausted juniors try each senior once before a threshold pause', async () => {
    const policy = createDateFreeParserPolicy();
    for (let i = 0; i < 8; i++) await policy.run('text', async () => 'ok');
    const models = [];
    await assert.rejects(policy.run('vision', async model => {
        models.push(model);
        throw new Error('503');
    }, 'first'), { code: 'DATE_FREE_PHASE_PAUSED' });
    assert.deepEqual(models, [...Array(4).fill('gpt-5.6-luna'), ...Array(4).fill('gpt-5.6-terra'), 'gpt-6.1-sol', 'gpt-6-astra']);
    assert.equal(policy.snapshot().lunaFailureRatio, 4 / 12);
    assert.equal(policy.snapshot().terraFailureRatio, 1);
    assert.equal(policy.snapshot().stopped, true);
});

test('Terra retries when its failure share reaches exactly 50 percent', async () => {
    const policy = createDateFreeParserPolicy();
    for (let i = 0; i < 20; i++) await policy.run('text', async () => 'ok');
    await policy.run('text', async model => {
        if (model === 'gpt-5.6-luna') throw new Error('503');
        return 'ok';
    });
    let terraCalls = 0;
    assert.equal(await policy.run('vision', async model => {
        if (model === 'gpt-5.6-luna') throw new Error('503');
        if (++terraCalls === 1) throw new Error('503');
        assert.equal(policy.snapshot().terraFailureRatio, 0.5);
        return 'recovered';
    }), 'recovered');
    assert.equal(terraCalls, 2);
});

test('threshold pause after failed seniors prevents subsequent paid calls', async () => {
    const policy = createDateFreeParserPolicy();
    for (let i = 0; i < 8; i++) await policy.run('text', async () => 'ok');
    const models = [];
    const fail = async (model) => { models.push(model); throw new Error('503'); };
    await assert.rejects(policy.run('vision', fail), { code: 'DATE_FREE_PHASE_PAUSED' });
    assert.equal(policy.snapshot().stopped, true);

    const terraPolicy = createDateFreeParserPolicy();
    const terraModels = [];
    for (let i = 0; i < 8; i++) await terraPolicy.run('text', async () => 'ok');
    await assert.rejects(terraPolicy.run('vision', async model => {
        terraModels.push(model);
        if (model === 'gpt-5.6-luna') throw new Error('503');
        throw new Error('terra-503');
    }), { code: 'DATE_FREE_PHASE_PAUSED' });
    assert.equal(terraPolicy.snapshot().terraFailureRatio, 1);
    assert.equal(terraPolicy.snapshot().stopped, true);
    const beforePause = terraModels.length;
    await assert.rejects(terraPolicy.run('vision', async model => {
        terraModels.push(model);
        throw new Error('503');
    }), { code: 'DATE_FREE_PHASE_PAUSED' });
    assert.equal(terraPolicy.snapshot().stopped, true);
    assert.equal(terraModels.length, beforePause);
});

for (const capability of ['text', 'vision']) {
    for (const successfulSenior of ['gpt-6.1-sol', 'gpt-6-astra']) {
        test(`${capability}: ${successfulSenior} rescues a high-failure request; next request restarts at Luna`, async () => {
            const policy = createDateFreeParserPolicy();
            const calls = [];
            const request = async model => {
                calls.push(model);
                if (model === successfulSenior) return 'recovered';
                throw new Error('503');
            };
            assert.equal(await policy.run(capability, request, 'one'), 'recovered');
            const expected = [...Array(4).fill('gpt-5.6-luna'), ...Array(4).fill('gpt-5.6-terra'), 'gpt-6.1-sol',
                ...(successfulSenior === 'gpt-6-astra' ? ['gpt-6-astra'] : [])];
            assert.deepEqual(calls, expected);
            assert.equal(policy.snapshot().stopped, false);
            // Same request key reuses its result without paying again.
            await policy.run(capability, request, 'one');
            assert.deepEqual(calls, expected);
            await policy.run(capability, request, 'two');
            assert.deepEqual(calls, [...expected, ...expected]);
            assert.equal(policy.snapshot().models[successfulSenior].capabilities[capability].successes, 2);
            const cheap = [];
            assert.equal(await policy.run(capability, async model => { cheap.push(model); return 'cheap'; }, 'three'), 'cheap');
            assert.deepEqual(cheap, ['gpt-5.6-luna']);
        });
    }
}

test('senior failures below junior thresholds leave only the request unresolved', async () => {
    const policy = createDateFreeParserPolicy({ minimumSample: 100 });
    await assert.rejects(policy.run('text', async () => { throw new Error('503'); }), /503/);
    assert.equal(policy.snapshot().stopped, false);
    assert.equal(await policy.run('text', async () => 'ok'), 'ok');
});

test('random pacing reserves independent text and Vision start times without waiting for responses', async () => {
    const waits = [];
    const pace = createParserAttemptPacer({ now: () => 0, gap: () => 23000, sleep: async ms => { waits.push(ms); } });
    await Promise.all([pace('vision'), pace('text'), pace('vision'), pace('vision'), pace('text')]);
    assert.deepEqual(waits, [23000, 46000, 23000]);
});

test('turbo modes use bounded random gaps', async () => {
    const waits = [];
    const pace = createParserAttemptPacer({ mode: 'turbo2', now: () => 0, random: () => 0.5, sleep: async ms => waits.push(ms) });
    await pace('vision');
    await pace('vision');
    assert.deepEqual(waits, [8500]);
    const turbo3 = createParserAttemptPacer({ mode: 'turbo3', now: () => 0, random: () => 1, sleep: async ms => waits.push(ms) });
    await turbo3('text');
    await turbo3('text');
    assert.equal(waits.at(-1), 6000);
});
