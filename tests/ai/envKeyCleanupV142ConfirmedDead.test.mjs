import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupConfirmedDeadKeysFromReport } from '../../src/features/ai/envKeyCleanup.js';

test('V142 cleanup removes confirmed zero-working keys but preserves uncertain/network and protected keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gigorave-v142-cleanup-'));
    const auditDir = join(dir, 'audit');
    const runtimeEnv = {
        OPENAI_COMPAT_API_KEY: 'owner-protected',
        OPENAI_API_KEY_1: 'confirmed-dead',
        OPENAI_API_KEY_2: 'network-uncertain',
        GROQ_API_KEY_1: 'working-recovered',
    };
    await writeFile(join(dir, '.env'), [
        'OPENAI_COMPAT_API_KEY=owner-protected',
        'OPENAI_API_KEY_1=confirmed-dead',
        'OPENAI_API_KEY_2=network-uncertain',
        'GROQ_API_KEY_1=working-recovered',
        '',
    ].join('\n'));

    const report = {
        outDir: auditDir,
        keyAudit: { results: [] },
        keySecondSweep: { results: [
            { envName: 'OPENAI_API_KEY_1', verdict: 'dead-confirmed' },
            { envName: 'OPENAI_API_KEY_2', verdict: 'uncertain' },
            { envName: 'GROQ_API_KEY_1', verdict: 'working-recovered' },
            { envName: 'OPENAI_COMPAT_API_KEY', verdict: 'dead-confirmed' },
        ] },
    };

    try {
        const result = await cleanupConfirmedDeadKeysFromReport({ report, directory: dir, runtimeEnv, auditOutDir: auditDir });
        assert.deepEqual(result.removed, ['OPENAI_API_KEY_1']);
        const envText = await readFile(join(dir, '.env'), 'utf8');
        assert.doesNotMatch(envText, /confirmed-dead/u);
        assert.match(envText, /network-uncertain/u);
        assert.match(envText, /working-recovered/u);
        assert.match(envText, /owner-protected/u);
        assert.equal(runtimeEnv.OPENAI_API_KEY_1, undefined);
        assert.equal(runtimeEnv.OPENAI_API_KEY_2, 'network-uncertain');
        assert.ok(result.backupPath);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
