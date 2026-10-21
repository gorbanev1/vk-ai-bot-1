import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'gigorave-v119-runtime-policy-'));
try {
    const source = new URL('../../src/infrastructure/database/index.js', import.meta.url);
    const target = join(root, 'src', 'infrastructure', 'database', 'index.js');
    const dateEvidenceSource = new URL('../../src/features/events/publicPostDateEvidence.js', import.meta.url);
    const dateEvidenceTarget = join(root, 'src', 'features', 'events', 'publicPostDateEvidence.js');
    const autoSummaryStoreSource = new URL('../../src/infrastructure/database/autoSummaryStateStore.js', import.meta.url);
    const autoSummaryStoreTarget = join(root, 'src', 'infrastructure', 'database', 'autoSummaryStateStore.js');
    mkdirSync(join(root, 'src', 'infrastructure', 'database'), { recursive: true });
    mkdirSync(join(root, 'src', 'features', 'events'), { recursive: true });
    cpSync(source, target);
    cpSync(dateEvidenceSource, dateEvidenceTarget);
    cpSync(autoSummaryStoreSource, autoSummaryStoreTarget);
    process.env.GIGORAVE_STATE_DIR = join(root, 'state');
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n', 'utf8');
    const db = await import(`${pathToFileURL(target).href}?v119=${Date.now()}`);

    db.replaceAiRuntimeModes([
        {
            provider: 'openai-compatible', envName: 'OPENAI_COMPAT_API_KEY', masked: 'sk…', model: 'gpt-5.6-sol', capability: 'text',
            endpoint: 'chat/completions', preferredTransport: 'stream', fallbackTransport: 'non_stream_retry_once', fallbackEndpoint: 'chat/completions',
            nonStreamOk: false, streamOk: true, reasoningModes: ['low', 'medium', 'high'],
            reasoningPolicies: {
                high: { keep: true, preferredTransport: 'stream', fallbackTransport: 'non_stream_retry_once', nonStreamOk: false, streamOk: true },
                medium: { keep: true, preferredTransport: 'non_stream', fallbackTransport: 'stream', nonStreamOk: true, streamOk: true },
            },
            testedAt: 119,
        },
    ], 119);

    const [row] = db.getAiRuntimeModes({ capability: 'text' });
    assert.equal(row.preferredTransport, 'stream');
    assert.equal(row.fallbackTransport, 'non_stream_retry_once');
    assert.equal(row.nonStreamOk, false);
    assert.equal(row.streamOk, true);
    assert.deepEqual(row.reasoningModes, ['low', 'medium', 'high']);
    assert.equal(row.reasoningPolicies.high.preferredTransport, 'stream');

    const policy = db.getAiRuntimeModePolicy({ provider: 'openai-compatible', envName: 'OPENAI_COMPAT_API_KEY', model: 'gpt-5.6-sol', capability: 'text' });
    assert.equal(policy.preferredTransport, 'stream');
    assert.equal(policy.fallbackTransport, 'non_stream_retry_once');
    assert.equal(policy.reasoningPolicies.medium.preferredTransport, 'non_stream');
} finally {
    rmSync(root, { recursive: true, force: true });
}

console.log('AI runtime policy V119 tests: ok');
