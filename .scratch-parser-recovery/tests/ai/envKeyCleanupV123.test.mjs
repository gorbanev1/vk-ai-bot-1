import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { cleanupDefinitiveDeadKeysFromReport } from '../../src/features/ai/envKeyCleanup.js';

test('V123 removes only definitively invalid foreign keys from .env', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gigorave-env-cleanup-'));
  const auditDir = join(dir, 'audit');
  const runtimeEnv = {
    OPENAI_COMPAT_API_KEY: 'owner-gpt',
    GIGACHAT_CREDENTIALS: 'owner-giga',
    OPENAI_API_KEY_1: 'dead-openai',
    OPENAI_API_KEY_2: 'quota-openai',
    ANTHROPIC_API_KEY_1: 'dead-anthropic',
    GEMINI_API_KEY_1: 'restricted-gemini',
  };
  await writeFile(join(dir, '.env'), [
    'OPENAI_COMPAT_API_KEY=owner-gpt',
    'GIGACHAT_CREDENTIALS=owner-giga',
    'OPENAI_API_KEY_1=dead-openai',
    'OPENAI_API_KEY_2=quota-openai',
    'ANTHROPIC_API_KEY_1=dead-anthropic',
    'GEMINI_API_KEY_1=restricted-gemini',
    '',
  ].join('\n'));
  const report = { keyAudit: { results: [
    { envName: 'OPENAI_API_KEY_1', status: 401, error: 'Incorrect API key provided' },
    { envName: 'OPENAI_API_KEY_2', status: 429, error: 'You exceeded your current quota' },
    { envName: 'ANTHROPIC_API_KEY_1', status: 401, error: 'API key is invalid' },
    { envName: 'GEMINI_API_KEY_1', status: 403, error: 'API method blocked by restriction' },
    { envName: 'OPENAI_COMPAT_API_KEY', status: 401, error: 'invalid api key' },
  ] }, outDir: auditDir };
  try {
    const result = await cleanupDefinitiveDeadKeysFromReport({ report, directory: dir, runtimeEnv, auditOutDir: auditDir });
    assert.deepEqual(result.removed, ['ANTHROPIC_API_KEY_1', 'OPENAI_API_KEY_1']);
    const envText = await readFile(join(dir, '.env'), 'utf8');
    assert.doesNotMatch(envText, /dead-openai/u);
    assert.doesNotMatch(envText, /dead-anthropic/u);
    assert.match(envText, /quota-openai/u);
    assert.match(envText, /restricted-gemini/u);
    assert.match(envText, /owner-gpt/u);
    assert.match(envText, /owner-giga/u);
    assert.ok(result.backupPath);
    assert.equal(runtimeEnv.OPENAI_API_KEY_1, undefined);
    assert.equal(runtimeEnv.ANTHROPIC_API_KEY_1, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
