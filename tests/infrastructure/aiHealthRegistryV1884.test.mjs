import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'gigorave-v1884-ai-health-'));
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
    const db = await import(`${pathToFileURL(target).href}?v1884=${Date.now()}`);

    db.replaceAiHealthRegistry({
        keys: [{ provider: 'xai', envName: 'XAI_API_KEY', masked: 'xai…', status: 'working', catalogStatus: 200, catalogLatencyMs: 55, modelsSeen: 2, workingModels: 1 }],
        models: [
            { provider: 'xai', envName: 'XAI_API_KEY', masked: 'xai…', model: 'grok-4.6', capability: 'text', status: 'working', nonStreamOk: true, streamOk: true, nonStreamStatus: 200, streamStatus: 200, nonStreamLatencyMs: 100, streamLatencyMs: 90, preferredTransport: 'non_stream' },
            { provider: 'xai', envName: 'XAI_API_KEY', masked: 'xai…', model: 'old-dead', capability: 'text', status: 'dead', nonStreamStatus: 404, streamStatus: 404, lastError: 'not found' },
        ],
    }, 1884);

    assert.equal(db.getAiKeyHealthRows().length, 1);
    assert.equal(db.getAiModelHealthRows().length, 2);
    assert.equal(db.getAiModelHealthStatus({ provider: 'xai', envName: 'XAI_API_KEY', model: 'grok-4.6', capability: 'text' }).status, 'working');
    assert.equal(db.getAiModelHealthStatus({ provider: 'xai', envName: 'XAI_API_KEY', model: 'old-dead', capability: 'text' }).status, 'dead');
} finally {
    rmSync(root, { recursive: true, force: true });
}

console.log('AI health registry V188.4: ok');
