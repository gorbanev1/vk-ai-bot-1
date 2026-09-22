import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    createProjectAuditBatches,
    createProjectAuditChunks,
} from '../../src/features/audit/projectArchiveAudit.js';

const appSource = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const versionSource = readFileSync(new URL('../../src/shared/buildVersion.js', import.meta.url), 'utf8');

test('V188.106 project audit uses smaller request batches to avoid proxy 524s', () => {
    const files = Array.from({ length: 20 }, (_, index) => ({
        path: `project/src/file-${index}.js`,
        sha256: String(index),
        content: 'x'.repeat(30_000),
    }));
    const chunks = createProjectAuditChunks(files);
    const batches = createProjectAuditBatches(chunks);
    assert.ok(batches.length >= 7);
    assert.ok(batches.every((batch) => batch.length <= 6));
    assert.ok(batches.every((batch) => batch.reduce((sum, chunk) => sum + chunk.chars + 500, 0) <= 97_000));
});

test('V188.106 Astra project audit detaches from the Telegram request lifetime', () => {
    assert.match(appSource, /name: `project-archive-audit:\$\{jobId\}`/u);
    assert.match(appSource, /timeoutMs: PROJECT_ARCHIVE_AUDIT_OPERATION_TIMEOUT_MS/u);
    assert.match(appSource, /const auditTask = runDetachedSupervisedOperation/u);
    assert.match(appSource, /void auditTask\.catch\(\(\) => \{\}\)/u);
});

test('V188.106 transient provider failures retry and oversized batches split instead of killing the job', () => {
    assert.match(appSource, /function isRetryableProjectAuditError/u);
    assert.match(appSource, /(?:500\|502\|503\|504\|520\|522\|523\|524)/u);
    assert.match(appSource, /projectAuditStage\(jobId, 'ai-batch-split'/u);
    assert.match(appSource, /auditProjectBatchResilient/u);
    assert.match(appSource, /PROJECT_ARCHIVE_AUDIT_LEAF_RETRY_LIMIT/u);
});

test('V188.106 project audit prefers background Responses and polls by response id', () => {
    assert.match(appSource, /backgroundResponse: useBackground/u);
    assert.match(appSource, /background: true/u);
    assert.match(appSource, /responses\/\$\{encodeURIComponent\(responseId\)\}/u);
    assert.match(appSource, /GPT ASTRA BACKGROUND POLL/u);
    assert.match(appSource, /background-mode-fallback/u);
});

test('V188.106 project audit never falls back from a stalled Astra stream to non-stream', () => {
    assert.match(appSource, /disableTransportFallback: true/u);
    assert.match(appSource, /AI RUNTIME TRANSPORT FALLBACK DISABLED/u);
    assert.match(appSource, /useCredentialHealth: false/u);
});

test('V188.106 waits for already-started workers before reporting a terminal failure', () => {
    assert.match(appSource, /await Promise\.allSettled\(runners\)/u);
    assert.match(appSource, /if \(firstError\) throw firstError/u);
});

test('V188.106 persists project audit checkpoints and hierarchically condenses final findings', () => {
    assert.match(appSource, /data\/audit-jobs/u);
    assert.match(appSource, /writeProjectAuditCheckpoint/u);
    assert.match(appSource, /condenseProjectAuditFindings/u);
    assert.match(appSource, /finding-synthesis-round/u);
});

test('V188.106 resilience remains present in successor builds', () => {
    assert.ok(Number(versionSource.match(/V188\.(\d+)/u)?.[1] ?? -1) >= 106);
});
