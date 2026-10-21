import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const configStart = source.indexOf('const PROJECT_ARCHIVE_INPUT_MODE = (() => {');
const configEnd = source.indexOf('const PROJECT_ARCHIVE_SINGLE_MAX_CHARS =', configStart);
assert.ok(configStart > 0 && configEnd > configStart, 'archive config block exists');
const config = source.slice(configStart, configEnd);

function bootConfig(env = {}) {
    const logs = [];
    const sandbox = {
        process: { env },
        PROJECT_ARCHIVE_AUDIT_CONCURRENCY: 1,
        console: { log: (...parts) => logs.push(parts.join(' ')) },
    };
    const values = vm.runInNewContext(`${config}\n({
        mode: shouldUseProjectArchiveTextMultipass() ? 'multipass' : 'single-shot',
        inputMode: PROJECT_ARCHIVE_INPUT_MODE,
        transport: PROJECT_ARCHIVE_MULTIPASS_TRANSPORT,
        concurrency: PROJECT_ARCHIVE_AUDIT_CONCURRENCY,
    })`, sandbox);
    return { ...values, logs };
}

test('V188.119: default/auto/invalid input + auto/background transport always route to text stream', () => {
    for (const mode of [undefined, '', 'auto', 'AUTO', 'not-a-mode', 'text']) {
        for (const transport of [undefined, '', 'auto', 'background', 'stream', 'unknown']) {
            const env = {};
            if (mode !== undefined) env.PROJECT_ARCHIVE_INPUT_MODE = mode;
            if (transport !== undefined) env.PROJECT_ARCHIVE_MULTIPASS_TRANSPORT = transport;
            env.PROJECT_ARCHIVE_AUDIT_MULTIPASS = '0';
            const config = bootConfig(env);
            assert.equal(config.inputMode, 'text', `input=${mode} transport=${transport}`);
            assert.equal(config.transport, 'stream', `input=${mode} transport=${transport}`);
            assert.equal(config.mode, 'multipass');
            assert.match(config.logs[0], /mode=multipass inputMode=text transport=stream concurrency=1/u);
        }
    }
});

test('V188.119: experimental /files branch requires explicit file mode, even with a stale multipass flag', () => {
    for (const legacy of ['0', '1']) {
        const config = bootConfig({
            PROJECT_ARCHIVE_INPUT_MODE: 'file',
            PROJECT_ARCHIVE_AUDIT_MULTIPASS: legacy,
        });
        assert.equal(config.inputMode, 'file');
        assert.equal(config.mode, 'single-shot');
    }
    const trimmed = bootConfig({ PROJECT_ARCHIVE_INPUT_MODE: ' FILE ' });
    assert.equal(trimmed.mode, 'single-shot');
});

test('V188.119: input-file ZIP is constructed solely inside explicit file branch; text branch builds batches', () => {
    assert.match(source, /const useTextMultipass = shouldUseProjectArchiveTextMultipass\(\);/u);
    assert.match(source, /if \(!useTextMultipass\) \{\s*const inputManifest/u);
    const zipBuild = source.indexOf('const sanitizedZip = buildPatchedProjectZip(', source.indexOf('if (!useTextMultipass) {'));
    const textStart = source.indexOf("projectAuditStage(jobId, 'text-multipass-start'", zipBuild);
    const branch = source.slice(source.indexOf('if (!useTextMultipass) {'), textStart);
    assert.ok(zipBuild > 0 && branch.includes('uploadToModel: true'));
    assert.match(branch, /return true;\s*\}\s*const chunks = createProjectAuditChunks/u);
    const textCode = source.slice(textStart - 300, source.indexOf('let completedBatches =', textStart));
    assert.match(textCode, /createProjectAuditChunks\(selection\.files\)/u);
    assert.match(textCode, /createProjectAuditBatches\(chunks\)/u);
    assert.doesNotMatch(textCode, /uploadOpenAIInputFile|sanitizedZip|input_file/u);
});

test('V188.119: model text stages enforce stream without non-stream fallback and durable batch checkpoint', () => {
    assert.match(source, /const multipassStream = stage !== 'single-shot' &&\s*\(textStage \|\| PROJECT_ARCHIVE_MULTIPASS_TRANSPORT === 'stream'\)/u);
    assert.match(source, /backgroundResponse: useBackground,\s*streamOverride: useBackground \? false : true,\s*disableTransportFallback: true/u);
    assert.match(source, /batchCheckpoint\[batchIndex\] = \{\s*batch: batchIndex \+ 1,\s*stage: `batch-\$\{batchIndex \+ 1\}`,\s*status: 'completed'/u);
    assert.match(source, /const checkpointPath = requireProjectAuditCheckpoint\(jobId, \{/u);
    assert.match(source, /PROJECT_ARCHIVE_TEXT_MODE_FILE_INPUT_FORBIDDEN/u);
});
