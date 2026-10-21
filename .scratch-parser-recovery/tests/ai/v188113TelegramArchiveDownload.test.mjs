import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import vm from 'node:vm';

const source = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
function extractFunction(name) {
    const start = source.indexOf(`async function ${name}(`);
    assert.ok(start >= 0, `${name} not found`);
    const end = source.indexOf('\n}\n', start);
    assert.ok(end > start, `${name} closing brace not found`);
    return source.slice(start, end + 2);
}

function createDownloader(fetcher, attempts = 2) {
    const context = {
        fetch: fetcher, Buffer, createHash, resolve, dirname,
        mkdirAsync: mkdir, openAsync: open, renameAsync: rename, unlinkAsync: unlink,
        TELEGRAM_MODEL_FILE_MAX_BYTES: 2_000_000,
        TELEGRAM_MODEL_FILE_DOWNLOAD_ATTEMPTS: attempts,
        TELEGRAM_MODEL_FILE_DOWNLOAD_IDLE_MS: 10000,
        getCurrentOperationSignal: () => null,
        createIdleAbortWatchdog: () => ({signal: new AbortController().signal, touch() {}, dispose() {}}),
        combineAbortSignals: (signals) => signals.find(Boolean),
        isRetryableTelegramFileTransferError: (error) => Number(error?.status || 0) >= 500,
        delayMs: async () => {},
        formatPrivateError: (e) => e.message,
        console: {warn() {}},
    };
    return {
        downloadToPath: vm.runInNewContext(`(${extractFunction('downloadTelegramFileToPath')})`, context),
        downloadBuffer: vm.runInNewContext(`(${extractFunction('downloadTelegramFileBuffer')})`, context),
    };
}

function response(body, headers = {}, status = 200) {
    return new Response(body, {status, headers});
}

async function withTempFile(callback) {
    const directory = mkdtempSync(join(tmpdir(), 'gigorave-telegram-download-'));
    try { return await callback(join(directory, 'source.zip')); }
    finally { rmSync(directory, {recursive:true, force:true}); }
}

test('real project ZIP download: identity body succeeds, fs rename and SHA match, no ReferenceError', async () => {
    const bytes = Buffer.from('PK\\x03\\x04a harmless ZIP-header-shaped test payload', 'latin1');
    const {downloadToPath} = createDownloader(async () => response(bytes, {'content-length': String(bytes.length)}));
    await withTempFile(async (outputPath) => {
        const result = await downloadToPath('https://fake.invalid/source.zip', {outputPath, filename:'test.zip'});
        assert.equal(result.fileSize, bytes.length);
        assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
        assert.deepEqual(readFileSync(result.filePath), bytes);
        assert.equal(existsSync(`${outputPath}.part`), false);
    });
});

test('truncated Telegram file is rejected and never promoted from .part', async () => {
    const {downloadToPath} = createDownloader(async () => response('short', {'content-length': '100'}), 1);
    await withTempFile(async (outputPath) => {
        await assert.rejects(downloadToPath('https://fake.invalid/source.zip', {outputPath}),
            error => error.code === 'TELEGRAM_PARTIAL_DOWNLOAD' && /length mismatch/u.test(error.message));
        assert.equal(existsSync(outputPath), false);
        assert.equal(existsSync(`${outputPath}.part`), false);
    });
});

test('truncated Telegram body retries only download, then saves the correct file', async () => {
    let calls = 0;
    const {downloadToPath} = createDownloader(async () => {
        calls++;
        return calls === 1 ? response('bad', {'content-length':'12'}) : response('correct', {'content-length':'7'});
    });
    await withTempFile(async (outputPath) => {
        const saved = await downloadToPath('https://fake.invalid/source.zip', {outputPath});
        assert.equal(calls, 2);
        assert.equal(readFileSync(saved.filePath, 'utf8'), 'correct');
    });
});

test('compressed response may be decoded transparently: decoded length need not equal encoded Content-Length', async () => {
    const {downloadToPath} = createDownloader(async () => response('decoded', {'content-encoding':'gzip','content-length':'40'}), 1);
    await withTempFile(async (outputPath) => {
        const saved = await downloadToPath('https://fake.invalid/source.zip', {outputPath});
        assert.equal(saved.fileSize, 7);
    });
});

test('HTTP 206 is rejected for whole-file project ZIP download', async () => {
    const {downloadToPath} = createDownloader(async () => response('bytes', {'content-range':'bytes 0-4/10'}, 206), 1);
    await withTempFile(async (outputPath) => {
        await assert.rejects(downloadToPath('https://fake.invalid/source.zip', {outputPath}),
            error => error.code === 'TELEGRAM_PARTIAL_DOWNLOAD');
        assert.equal(existsSync(outputPath), false);
    });
});

test('ordinary Buffer downloader also rejects truncated body', async () => {
    const {downloadBuffer} = createDownloader(async () => response('short', {'content-length':'100'}), 1);
    await assert.rejects(downloadBuffer('https://fake.invalid/source.zip'),
        error => error.code === 'TELEGRAM_PARTIAL_DOWNLOAD');
});
