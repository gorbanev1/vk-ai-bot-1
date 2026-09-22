import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    runFullAiAudit,
    summarizeAuditWithSol,
} from '../../src/features/ai/fullAiAudit.js';
import { parseProviderCommand } from '../../src/features/ai/providerDiagnostics.js';

assert.equal(parseProviderCommand('тест всех моделей').action, 'full_models_audit');
assert.equal(parseProviderCommand('проверить все модели').action, 'full_models_audit');

const root = mkdtempSync(join(tmpdir(), 'gigorave-v118-full-audit-'));
const env = {
    OPENAI_API_KEY: 'sk-test-key-1234567890',
    OPENAI_API_BASE_URL: 'https://example.invalid/v1',
    OPENAI_COMPAT_API_KEY: 'TEST_OPENAI_KEY_REDACTED',
    OPENAI_COMPAT_BASE_URL: 'https://router.invalid/v1',
    GPT_MODEL_PRO3: 'gpt-5.6-sol',
};

const keyAuditRunner = async () => ({
    checkedAt: new Date().toISOString(),
    total: 2,
    valid: 2,
    invalid: 0,
    results: [
        {
            provider: 'openai', envName: 'OPENAI_API_KEY', masked: 'sk-test…7890', ok: true, status: 200, elapsedMs: 1, error: '', account: '', note: '',
            models: [{ id: 'gpt-test-chat', capabilities: ['text'], description: '', displayName: '', methods: [] }],
        },
        {
            provider: 'openai-compatible', envName: 'OPENAI_COMPAT_API_KEY', masked: 'sk-rout…7890', ok: true, status: 200, elapsedMs: 1, error: '', account: '', note: '',
            models: [{ id: 'gpt-5.6-sol', capabilities: ['text'], description: '', displayName: '', methods: [] }],
        },
    ],
});

const visualAuditRunner = async ({ directory }) => ({
    outDir: join(directory, 'GRAPHICS_MATRIX_RESULTS', 'fake'),
    summaryPath: join(directory, 'graphics-summary.txt'),
    jsonlPath: join(directory, 'graphics-results.jsonl'),
    attempts: 2,
    results: [
        { index: 1, total: 2, provider: 'openai', envName: 'OPENAI_API_KEY', masked: 'sk-test…7890', model: 'gpt-image-test', ok: true, status: 200, elapsedMs: 2, error: '', imagePath: join(directory, 'image.png'), imageBytes: 12, mimeType: 'image/png' },
        { index: 2, total: 2, provider: 'openai', envName: 'OPENAI_API_KEY', masked: 'sk-test…7890', model: 'broken-image', ok: false, status: 429, elapsedMs: 3, error: 'rate limit', imagePath: '', imageBytes: 0, mimeType: '' },
    ],
});

const fakeFetch = async (url) => ({
    ok: true,
    status: 200,
    async text() {
        if (String(url).includes('/responses')) return JSON.stringify({ output_text: 'GIGORAVE_AUDIT_OK' });
        return JSON.stringify({ choices: [{ message: { content: 'GIGORAVE_AUDIT_OK' } }] });
    },
});

try {
    const report = await runFullAiAudit({
        env,
        directory: root,
        fetchImpl: fakeFetch,
        keyAuditRunner,
        visualAuditRunner,
        now: new Date('2026-08-24T09:00:00.000Z'),
    });

    assert.equal(report.stats.textAttempts, 1);
    assert.equal(report.stats.textOk, 1);
    assert.equal(report.stats.imageAttempts, 2);
    assert.equal(report.stats.imageOk, 1);
    assert.equal(report.workingModes.length, 2);
    assert.ok(report.retryCandidates.some((row) => row.kind === 'quota' && row.retryEligible));
    assert.match(readFileSync(report.textPath, 'utf8'), /GIGORAVE FULL AI MODEL AUDIT/u);
    assert.ok(JSON.parse(readFileSync(report.retryPath, 'utf8')).length >= 1);

    const sol = await summarizeAuditWithSol({ report, env, fetchImpl: fakeFetch });
    assert.equal(sol.ok, true);
    assert.equal(sol.model, 'gpt-5.6-sol');
} finally {
    rmSync(root, { recursive: true, force: true });
}

console.log('full AI audit V118 tests: ok');
