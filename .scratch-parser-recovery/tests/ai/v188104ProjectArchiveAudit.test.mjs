import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    buildPatchedProjectZip,
    createProjectAuditBatches,
    createProjectAuditChunks,
    isAuditableProjectTextPath,
    isSensitiveProjectPath,
    parseProjectZipArchive,
    selectProjectAuditFiles,
} from '../../src/features/audit/projectArchiveAudit.js';

const appSource = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const versionSource = readFileSync(new URL('../../src/shared/buildVersion.js', import.meta.url), 'utf8');

function fakeArchive() {
    const entries = [
        { path: 'project/src/a.js', isDirectory: false, method: 0, modTime: 0, modDate: 0, externalAttributes: 0 },
        { path: 'project/.env', isDirectory: false, method: 0, modTime: 0, modDate: 0, externalAttributes: 0 },
        { path: 'project/data/runtime.json', isDirectory: false, method: 0, modTime: 0, modDate: 0, externalAttributes: 0 },
    ];
    const data = new Map([
        ['project/src/a.js', Buffer.from('export const value = 1;\n')],
        ['project/.env', Buffer.from('SECRET=never-send\n')],
        ['project/data/runtime.json', Buffer.from('{"private":true}')],
    ]);
    return {
        entries,
        limits: {},
        readEntry(entry) { return data.get(entry.path); },
    };
}

test('V188.104 owner ZIP audit route runs before generic Telegram file input', () => {
    assert.match(appSource, /maybeHandleProjectArchiveAuditIncoming[\s\S]*?if \(!text\) \{/u);
    assert.match(appSource, /ZIP is never blindly sent to Responses as application\/octet-stream/u);
});

test('V188.104 archive selection excludes secrets/runtime directories and keeps source', () => {
    assert.equal(isSensitiveProjectPath('project/.env'), true);
    assert.equal(isSensitiveProjectPath('project/data/runtime.json'), true);
    assert.equal(isSensitiveProjectPath('project/node_modules/x.js'), true);
    assert.equal(isAuditableProjectTextPath('project/src/a.js'), true);
    const selection = selectProjectAuditFiles(fakeArchive());
    assert.deepEqual(selection.files.map((file) => file.path), ['project/src/a.js']);
});

test('V188.104 patched ZIP is structurally valid and preserves excluded bytes', () => {
    const source = fakeArchive();
    const zip = buildPatchedProjectZip(source, {
        replacements: new Map([['project/src/a.js', 'export const value = 2;\n']]),
        additions: new Map([['project/ASTRA_AUDIT_REPORT.md', '# report\n']]),
    });
    const parsed = parseProjectZipArchive(zip);
    const sourceEntry = parsed.entries.find((entry) => entry.path === 'project/src/a.js');
    const envEntry = parsed.entries.find((entry) => entry.path === 'project/.env');
    assert.match(parsed.readEntry(sourceEntry).toString('utf8'), /value = 2/u);
    assert.equal(parsed.readEntry(envEntry).toString('utf8'), 'SECRET=never-send\n');
    assert.ok(parsed.entries.some((entry) => entry.path === 'project/ASTRA_AUDIT_REPORT.md'));
});

test('V188.104 source batching is bounded and supports large projects', () => {
    const files = Array.from({ length: 70 }, (_, index) => ({
        path: `project/src/f${index}.js`,
        sha256: String(index),
        content: 'x'.repeat(12_000),
    }));
    const chunks = createProjectAuditChunks(files);
    const batches = createProjectAuditBatches(chunks);
    assert.ok(batches.length > 1);
    assert.ok(batches.every((batch) => batch.length <= 32));
});

test('V188.104 empty reasoning-only model output is retryable instead of terminal success', () => {
    assert.match(appSource, /code = 'EMPTY_MODEL_TEXT'/u);
    assert.match(appSource, /isEmptyModelTextError\(error\)[\s\S]*?isTechnicalModelFailure/u);
    assert.match(appSource, /GPT Responses API завершил ответ без текста и без доступных файлов/u);
});

test('V188.104 pre-routing media analysis is lazy and terminology sees raw user text only', () => {
    assert.match(appSource, /V188\.104: media\/vision analysis is deliberately lazy/u);
    assert.doesNotMatch(appSource, /function runWithIncomingGptRequest[\s\S]{0,900}?resolveRichIncomingMediaContext/u);
    assert.match(appSource, /detectUnknownTermsForMemoryLookup[\s\S]*?skipIncomingMessageContext: true/u);
    assert.match(appSource, /includeImageAnalysis: options\?\.includeIncomingImageAnalysis === true/u);
});

test('V188.104 AI logs carry request correlation id', () => {
    assert.match(appSource, /requestId: randomUUID\(\)/u);
    assert.match(appSource, /\[AI KEY ATTEMPT FAILED\][\s\S]*?requestId=/u);
    assert.match(appSource, /\[TELEGRAM MESSAGE HANDLER ERROR\][\s\S]*?requestId=/u);
});


test('V188.104 high reasoning reserves output budget so reasoning cannot starve visible text', () => {
    assert.match(appSource, /function getReasoningSafeMaxTokens/u);
    assert.match(appSource, /text_tokens = 0/u);
    assert.match(appSource, /\? 8_000/u);
    assert.match(appSource, /maxTokens: getReasoningSafeMaxTokens\(/u);
});

test('V188.104 build version is bumped', () => {
    assert.match(versionSource, /V188\.10[4-9]|V188\.1[1-9]\d/u);
});
