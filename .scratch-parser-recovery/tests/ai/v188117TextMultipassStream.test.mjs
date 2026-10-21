import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

test('V188.117 text override wins over disabled legacy multipass', () => {
    assert.match(app, /const PROJECT_ARCHIVE_INPUT_MODE = \(\(\) => \{/u);
    assert.match(app, /const useTextMultipass = shouldUseProjectArchiveTextMultipass\(\)/u);
    assert.match(app, /if \(!useTextMultipass\) \{\s*const inputManifest/u);
    assert.doesNotMatch(app, /if \(!PROJECT_ARCHIVE_AUDIT_MULTIPASS_ENABLED\) \{\s*const inputManifest/u);
});

test('V188.117 all project archive status/route labels use effective multipass mode', () => {
    assert.match(app, /mode: useTextMultipass \? 'multipass' : 'single-shot'/u);
    assert.match(app, /PROJECT_ARCHIVE_ROUTER_PROBE_ENABLED && useTextMultipass/u);
    assert.match(app, /\[PROJECT AUDIT CONFIG\]/u);
    assert.match(app, /projectAuditStage\(jobId, 'text-multipass-start', \{/u);
    assert.match(app, /projectAuditStage\(jobId, 'ai-batch-start', \{/u);
});

test('V188.117 text audit uses SSE even if background is otherwise supported', () => {
    assert.match(app, /if \(PROJECT_ARCHIVE_INPUT_MODE === 'text'\) return 'stream'/u);
    assert.match(app, /const multipassStream = stage !== 'single-shot' &&\s*\(textStage \|\| PROJECT_ARCHIVE_MULTIPASS_TRANSPORT === 'stream'\)/u);
    assert.match(app, /const useBackground = !multipassStream &&\s*\(forceBackground \|\| \(!forceStream && projectArchiveAuditBackgroundMode !== 'unsupported'\)\)/u);
    assert.match(app, /backgroundResponse: useBackground,[\s\S]*?streamOverride: useBackground \? false : true/u);
    assert.match(app, /disableTransportFallback: true/u);
});

test('V188.117 text audit never uploads to /files even if a future refactor passes inputFiles', () => {
    assert.match(app, /PROJECT_ARCHIVE_INPUT_MODE === 'text' &&\s*String\(tokenUsageOperation \|\| ''\)\.startsWith\('project-archive-audit:'\) &&\s*Array\.isArray\(inputFiles\) && inputFiles\.length\) \{\s*throw new Error\('PROJECT_ARCHIVE_TEXT_MODE_FILE_INPUT_FORBIDDEN/u);
    assert.match(app, /if \(!useTextMultipass\) \{[\s\S]*?uploadToModel: true/u);
    assert.match(app, /const batchResults = await runWithConcurrency\(\s*batches,\s*PROJECT_ARCHIVE_AUDIT_CONCURRENCY/u);
    assert.match(app, /batchResults: batchCheckpoint/u);
});
