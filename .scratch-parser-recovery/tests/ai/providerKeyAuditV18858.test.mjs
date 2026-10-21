import test from 'node:test';
import assert from 'node:assert/strict';
import { collectConfiguredAiCredentials } from '../../src/features/ai/providerKeyAudit.js';

test('V188.58: compat audit uses the same router default as runtime', () => {
    const rows = collectConfiguredAiCredentials({ OPENAI_COMPAT_API_KEY: 'secret' });
    const compat = rows.find((row) => row.provider === 'openai-compatible');
    assert.ok(compat);
    assert.equal(compat.baseUrl, 'https://router.cheap/v1');
});

test('V188.58: explicit compat base URL still wins', () => {
    const rows = collectConfiguredAiCredentials({
        OPENAI_COMPAT_API_KEY: 'secret',
        OPENAI_COMPAT_BASE_URL: 'https://custom.example/v1',
    });
    assert.equal(rows.find((row) => row.provider === 'openai-compatible')?.baseUrl, 'https://custom.example/v1');
});
