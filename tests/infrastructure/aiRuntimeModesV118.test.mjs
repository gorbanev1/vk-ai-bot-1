import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'gigorave-v118-ai-registry-'));
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
    const db = await import(`${pathToFileURL(target).href}?v118=${Date.now()}`);

    db.replaceAiRuntimeModes([
        { provider: 'openai', envName: 'OPENAI_API_KEY_1', masked: 'sk-1…', model: 'gpt-a', capability: 'text', endpoint: 'responses', testedAt: 100 },
        { provider: 'nvidia', envName: 'NVIDIA_API_KEY', masked: 'nv…', model: 'flux-a', capability: 'image', endpoint: 'provider-image-adapter', testedAt: 100 },
    ], 100);
    assert.equal(db.getAiRuntimeModes().length, 2);
    assert.equal(db.getAiRuntimeModes({ capability: 'text' }).length, 1);

    db.replaceAiRuntimeModes([
        { provider: 'openai', envName: 'OPENAI_API_KEY_1', masked: 'sk-1…', model: 'gpt-a', capability: 'text', endpoint: 'responses', testedAt: 200 },
    ], 200);
    const rows = db.getAiRuntimeModes();
    assert.equal(rows.length, 1, 'failed/omitted modes must be removed by atomic replacement');
    assert.equal(rows[0].model, 'gpt-a');
} finally {
    rmSync(root, { recursive: true, force: true });
}

console.log('AI runtime modes V118 tests: ok');
