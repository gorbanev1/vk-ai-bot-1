import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
    autoImportAiSecretsFromProjectRoot,
    collectRuntimeAiSecrets,
    parseRuntimeTrufflehogRecords,
} from '../../src/features/ai/runtimeSecretAutoImport.js';
import { collectConfiguredAiCredentials } from '../../src/features/ai/providerKeyAudit.js';

const sample = [
    { DetectorName: 'GoogleGeminiAPIKey', SecretParts: { key: 'AIzaSy0123456789012345678901234567890' } },
    { DetectorName: 'Groq', SecretParts: { key: 'TEST_GROQ_IMPORTED_0123456789' } },
    { DetectorName: 'OpenAI', SecretParts: { key: 'TEST_OPENAI_IMPORTED_0123456789' } },
    { DetectorName: 'Stripe', SecretParts: { key: 'sk_live_must_never_be_imported_01234567890' } },
].map((row) => JSON.stringify(row)).join('\n');

test('parses supported AI secrets and ignores non-AI detectors', () => {
    const records = parseRuntimeTrufflehogRecords(sample);
    const found = collectRuntimeAiSecrets(records);
    assert.equal(records.length, 4);
    assert.equal(found.get('GEMINI_API_KEY')?.length, 1);
    assert.equal(found.get('GROQ_API_KEY')?.length, 1);
    assert.equal(found.get('OPENAI_API_KEY')?.length, 1);
    assert.equal(found.has('STRIPE_API_KEY'), false);
});

test('bot-native import writes numbered slots and injects them into current process.env', () => {
    const root = mkdtempSync(join(tmpdir(), 'gigorave-v83-'));
    writeFileSync(join(root, '.env'), 'OPENAI_API_KEY=TEST_OPENAI_PRIMARY_ORIGINAL\nNVIDIA_API_KEY=TEST_NVIDIA_PRIMARY\n', 'utf8');
    writeFileSync(join(root, 'parsed_secrets.txt'), sample, 'utf8');

    const old = { ...process.env };
    try {
        delete process.env.GEMINI_API_KEY_1;
        delete process.env.GROQ_API_KEY_1;
        delete process.env.OPENAI_API_KEY_2;
    process.env.OPENAI_API_KEY = 'TEST_OPENAI_PRIMARY_ORIGINAL';
        process.env.NVIDIA_API_KEY = 'nvapi-primary-000000000000000';

        const result = autoImportAiSecretsFromProjectRoot({ projectRoot: root, log: false });
        assert.equal(result.sourceFound, true);
        assert.equal(result.additions.length, 3);
        assert.ok(process.env.GEMINI_API_KEY_1?.startsWith('AIza'));
    assert.equal(process.env.GROQ_API_KEY_1, 'TEST_GROQ_IMPORTED_0123456789');
    assert.equal(process.env.OPENAI_API_KEY_2, 'TEST_OPENAI_IMPORTED_0123456789');
    assert.equal(process.env.OPENAI_API_KEY, 'TEST_OPENAI_PRIMARY_ORIGINAL');

        const envText = readFileSync(join(root, '.env'), 'utf8');
        assert.match(envText, /GEMINI_API_KEY_1=/u);
        assert.match(envText, /GROQ_API_KEY_1=/u);
        assert.match(envText, /OPENAI_API_KEY_2=/u);
        assert.doesNotMatch(envText, /sk_live_must_never/u);

        const configured = collectConfiguredAiCredentials(process.env);
        assert.ok(configured.some((row) => row.envName === undefined || row.name === 'GEMINI_API_KEY_1'));
        assert.ok(configured.some((row) => row.name === 'OPENAI_API_KEY_2'));
    } finally {
        for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
        for (const [key, value] of Object.entries(old)) process.env[key] = value;
    }
});
