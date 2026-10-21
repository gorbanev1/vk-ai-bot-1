// Owner-DM-only TXT job operations. No model POST is performed by this module.
import { randomUUID, createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { appendTelegramTextTransferLog } from './telegramTextTransferLog.js';

const active = new Map();
let latestJobId = '';
const jobRoot = resolve(process.env.GIGORAVE_TEXT_DATA_DIR || 'data', 'astra-text-jobs');
const logRoot = resolve(process.env.GIGORAVE_TEXT_DATA_DIR || 'data', 'telegram-text-transfer-logs');
const valid = (id) => /^[a-f0-9-]{36}$/iu.test(String(id || ''));
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
// TXT inference must not be cancelled solely because the model/router has
// emitted no body bytes. Only explicit owner /txt_stop or external failure
// can end the wait; local inactivity produces diagnostics, not AbortController.
const quietWarningMs = 2 * 60 * 1000;
const repeatWarningMs = 15 * 60 * 1000;

export function beginTelegramTextJob({ jobId = randomUUID(), send = async () => {} }) {
    if (!valid(jobId)) throw new Error('TEXT_JOB_ID_INVALID');
    if (active.get(jobId)?.running) throw new Error('TEXT_JOB_ALREADY_RUNNING');
    const controller = new AbortController();
    const now = Date.now();
    const job = { jobId, controller, running: true, status: 'running', stage: '', completed: 0,
        total: 0, started: now, lastBytesAt: now, bytes: 0, lastWarning: 0,
        quiet: false, modelQuiet: false, lastTextWarning: 0, modelQuietSince: 0, send };
    active.set(jobId, job);
    latestJobId = jobId;
    void appendTelegramTextTransferLog({ jobId, event: { stage: 'job-start', status: 'running' } }).catch(() => {});
    return job;
}

export function getActiveTelegramTextJob(jobId = '') {
    return active.get(jobId || latestJobId) || null;
}

async function safeOwnerMessage(job, message) {
    if (!job?.running) return;
    try { await job.send(message); }
    catch (error) { await appendTelegramTextTransferLog({ jobId: job.jobId,
        event: { stage: 'telegram-notification-failed', code: error?.code || error?.name || 'unknown' } }).catch(() => {}); }
}

export async function observeTelegramTextJob(job, event = {}, now = Date.now()) {
    if (!job?.running) return;
    const stage = String(event.stage || '');
    if (stage) job.stage = stage;
    if ((stage === 'chunk-plan' || stage === 'whole-file-request-start') && Number(event.totalBatches)) job.total = Number(event.totalBatches);
    if (stage === 'part-complete') job.completed = Number(event.batch) || job.completed;
    if (stage === 'whole-file-request-complete') job.completed = 1;
    if (stage === 'chunk-replanned') job.total = Number(event.totalBatches) || job.total;
    if (stage === 'network-bytes-received' && Number(event.streamBytesReceived) > job.bytes) {
        const quietSeconds = Math.max(0, Math.round((now - job.lastBytesAt) / 1000));
        job.bytes = Number(event.streamBytesReceived);
        job.lastBytesAt = now;
        if (job.quiet) {
            job.quiet = false;
            job.lastWarning = 0;
            await appendTelegramTextTransferLog({ jobId: job.jobId,
                event: { stage: 'stream-resumed', quietSeconds, completed: job.completed, total: job.total } }).catch(() => {});
            await safeOwnerMessage(job, `✅ TXT: сервер снова присылает данные после простоя ${Math.round(quietSeconds / 60)} мин. Часть ${job.completed + 1}/${job.total || '?'}.`);
        }
    }
    if (stage === 'retry-attempt-start') {
        job.lastBytesAt = now;
        job.bytes = 0;
        job.quiet = false;
        job.lastWarning = 0;
        job.modelQuiet = false;
        job.lastTextWarning = 0;
        job.modelQuietSince = 0;
        job.headersReceived = false;
        job.httpStatus = 0;
        job.sseComments = 0;
    }
    if (stage === 'http-response-headers') {
        job.headersReceived = true;
        job.httpStatus = Number(event.httpStatus) || 0;
    }
    if (stage === 'sse-comment-received') job.sseComments = Number(event.sseComments) || job.sseComments || 0;
    if (stage === 'request-waiting') {
        const idleMs = Number.isFinite(Number(event.secondsSinceNetworkByte)) && event.secondsSinceNetworkByte != null
            ? Math.max(0, Number(event.secondsSinceNetworkByte) * 1000)
            : Math.max(0, Number(event.elapsedSec || 0) * 1000);
        if (idleMs >= quietWarningMs && now - job.lastWarning >= repeatWarningMs) {
            job.quiet = true;
            job.lastWarning = now;
            await appendTelegramTextTransferLog({ jobId: job.jobId,
                event: { stage: 'stream-stalled-warning', quietSeconds: Math.round(idleMs / 1000),
                    bytes: Number(event.streamBytesReceived || 0), completed: job.completed, total: job.total } }).catch(() => {});
            await safeOwnerMessage(job, `⚠️ TXT: возможно, поток простаивает ${Math.round(idleMs / 60_000)} мин. ` +
                `Готово ${job.completed}/${job.total || '?'}. Это НЕ означает, что модель остановилась. ` +
                `Команды: /txt_status, /txt_probe, /txt_log, /txt_stop. ` +
                `Проверка соединения — отдельный GET и не оживляет исходный streaming.`);
        }
        // An SSE heartbeat proves only transport liveness, not progress of the
        // model. Notify the owner separately if visible model text stops despite
        // healthy network bytes; do not kill a high-reasoning job just for this.
        const textIdleMs = event.secondsSinceText != null
            ? Math.max(0, Number(event.secondsSinceText) * 1000)
            : Math.max(0, Number(event.elapsedSec || 0) * 1000);
        if (!job.quiet && textIdleMs >= quietWarningMs && now - job.lastTextWarning >= repeatWarningMs) {
            job.modelQuiet = true;
            job.modelQuietSince ||= now - textIdleMs;
            job.lastTextWarning = now;
            await appendTelegramTextTransferLog({ jobId: job.jobId,
                event: { stage: 'model-text-stalled-warning', quietSeconds: Math.round(textIdleMs / 1000),
                    networkQuietSeconds: Math.round(idleMs / 1000), completed: job.completed, total: job.total } }).catch(() => {});
            await safeOwnerMessage(job, `⏳ TXT: сеть получает данные, но нового текста модели нет ${Math.round(textIdleMs / 60_000)} мин. ` +
                `Модель может рассуждать; это не доказательство зависания. Готово ${job.completed}/${job.total || '?'}. ` +
                `Команды: /txt_status, /txt_probe, /txt_log, /txt_stop.`);
        }
        if (job.modelQuiet && textIdleMs < 60_000) {
            const quietMinutes = Math.max(0, Math.round((now - job.modelQuietSince) / 60_000));
            job.modelQuiet = false;
            job.modelQuietSince = 0;
            job.lastTextWarning = 0;
            await appendTelegramTextTransferLog({ jobId: job.jobId,
                event: { stage: 'model-text-resumed', quietMinutes, completed: job.completed, total: job.total } }).catch(() => {});
            await safeOwnerMessage(job, `✅ TXT: модель снова присылает текст после ${quietMinutes} мин без видимого ответа. Продолжаю ${job.completed + 1}/${job.total || '?'}.`);
        }
        // No local inactivity abort, including after three hours. A router or
        // Cloudflare disconnect remains an external network failure, not a
        // justification to issue another paid POST.
    }
}

export async function finishTelegramTextJob(job, error = null) {
    if (!job) return;
    job.running = false;
    job.status = error ? (job.controller.signal.aborted ? 'stopped' : 'interrupted') : 'completed';
    await appendTelegramTextTransferLog({ jobId: job.jobId,
        event: { stage: 'job-finished', status: job.status, completed: job.completed, total: job.total,
            code: String(error?.code || error?.name || '') } }).catch(() => {});
}

async function latestDiskJobId() {
    const entries = await readdir(jobRoot, { withFileTypes: true }).catch(() => []);
    const rows = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || !valid(entry.name)) continue;
        try {
            const rec = JSON.parse(await readFile(join(jobRoot, entry.name, 'recipient.json'), 'utf8'));
            if (rec.jobId === entry.name) rows.push({ id: entry.name, when: String(rec.savedAt || '') });
        } catch {}
    }
    return rows.sort((a, b) => b.when.localeCompare(a.when))[0]?.id || '';
}
export async function resolveTelegramTextJobId(candidate = '') {
    if (candidate) {
        if (!valid(candidate)) throw new Error('Некорректный идентификатор TXT-задания.');
        return candidate;
    }
    return latestJobId || await latestDiskJobId();
}

export async function readTelegramTextJobLog(jobId, { tail = 3500 } = {}) {
    if (!valid(jobId)) throw new Error('TEXT_JOB_ID_INVALID');
    const content = await readFile(join(logRoot, jobId, 'transfer.log'), 'utf8');
    return tail ? content.slice(-tail) : content;
}

export async function telegramTextJobStatus(jobId) {
    if (!valid(jobId)) throw new Error('TEXT_JOB_ID_INVALID');
    const live = getActiveTelegramTextJob(jobId);
    if (live?.running) return { jobId, status: live.quiet ? 'possible-network-stall' : live.modelQuiet ? 'model-text-silent' : live.status,
        running: true, completed: live.completed, total: live.total, stage: live.stage,
        quietSeconds: Math.round((Date.now() - live.lastBytesAt) / 1000),
        bytes: live.bytes, headersReceived: Boolean(live.headersReceived),
        httpStatus: live.httpStatus || 0, sseComments: live.sseComments || 0,
        abortRequested: live.controller.signal.aborted };
    const root = join(jobRoot, jobId);
    const names = await readdir(root, { withFileTypes: true }).catch(() => []);
    let completed = 0;
    let unknown = 0;
    let responseIds = 0;
    let running = 0;
    for (const entry of names) {
        if (!entry.isDirectory() || !/^(?:part-\d+-\d+|full|whole-file|synthesis)$/u.test(entry.name)) continue;
        try {
            const state = JSON.parse(await readFile(join(root, entry.name, 'state.json'), 'utf8'));
            const isPart = entry.name.startsWith('part-');
            if (state.status === 'completed') { if (isPart || entry.name === 'whole-file' || entry.name === 'full') completed++; }
            else if (['request-started','stream-running','unknown','retry-scheduled','model-returned'].includes(state.status)) {
                unknown++; if (state.responseId) responseIds++;
            }
        } catch {}
    }
    const log = await readTelegramTextJobLog(jobId, { tail: 0 }).catch(() => '');
    const totals = [...log.matchAll(/\btotalBatches=(\d+)/gu)].map(row => Number(row[1]));
    const total = totals.length ? Math.max(...totals) : 0;
    return { jobId, status: unknown ? 'interrupted-ambiguous' : 'not-running', running,
        completed, total, unknown, responseIds, stage: '-' };
}

// The original input is needed for exact resumability: only the same jobId and
// same SHA256 can reuse stage outputs; never expose its bytes in progress logs.
export async function saveTelegramTextJobInput({ jobId, text, requestText, model, reasoningEffort, filename, wholeFile = false, root = jobRoot }) {
    if (!valid(jobId)) throw new Error('TEXT_JOB_ID_INVALID');
    const dir = join(root, jobId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const meta = { jobId, model, reasoningEffort, filename, requestText, wholeFile: Boolean(wholeFile),
        sha256: sha(text), textLength: text.length, savedAt: new Date().toISOString() };
    const prior = await readFile(join(dir, 'source.json'), 'utf8').catch(() => '');
    if (prior) {
        const existing = JSON.parse(prior);
        if (existing.sha256 !== meta.sha256 || existing.requestText !== meta.requestText || existing.model !== model || existing.reasoningEffort !== reasoningEffort || Boolean(existing.wholeFile) !== Boolean(wholeFile))
            throw new Error('TEXT_JOB_INPUT_MISMATCH');
        if (sha(await readFile(join(dir, 'source.txt'), 'utf8')) !== meta.sha256)
            throw new Error('TEXT_JOB_SOURCE_CHECKPOINT_DAMAGED');
        return;
    }
    const inputPath = join(dir, 'source.txt');
    await writeFile(`${inputPath}.tmp`, text, { mode: 0o600, flag: 'wx' });
    await rename(`${inputPath}.tmp`, inputPath);
    await writeFile(join(dir, 'source.json'), `${JSON.stringify(meta)}\n`, { mode: 0o600, flag: 'wx' });
    await appendTelegramTextTransferLog({ jobId, event: { stage: 'source-checkpoint-saved', chars: text.length } }).catch(() => {});
}

export async function loadTelegramTextJobInput(jobId, { root = jobRoot } = {}) {
    if (!valid(jobId)) throw new Error('TEXT_JOB_ID_INVALID');
    const dir = join(root, jobId);
    const meta = JSON.parse(await readFile(join(dir, 'source.json'), 'utf8'));
    const text = await readFile(join(dir, 'source.txt'), 'utf8');
    if (sha(text) !== meta.sha256 || meta.jobId !== jobId) throw new Error('TEXT_JOB_INPUT_HASH_MISMATCH');
    return { ...meta, text };
}

export async function getTelegramTextJobDeliveryState(jobId, { root = jobRoot, kind = 'final' } = {}) {
    if (!valid(jobId)) throw new Error('TEXT_JOB_ID_INVALID');
    if (!['final','partial'].includes(kind)) throw new Error('TEXT_DELIVERY_KIND_INVALID');
    try { return JSON.parse(await readFile(join(root, jobId, kind === 'partial' ? 'partial-delivery.json' : 'delivery.json'), 'utf8')); }
    catch { return null; }
}

export async function markTelegramTextJobDelivery({ jobId, status, filename, telegramMessageId = '', root = jobRoot, kind = 'final' }) {
    if (!valid(jobId) || !['sending-unknown', 'accepted'].includes(status) || !['final','partial'].includes(kind)) throw new Error('TEXT_DELIVERY_STATE_INVALID');
    const path = join(root, jobId, kind === 'partial' ? 'partial-delivery.json' : 'delivery.json');
    const previous = await getTelegramTextJobDeliveryState(jobId, { root, kind });
    if (previous?.status === 'accepted') return previous;
    if (previous?.status === 'sending-unknown' && status === 'sending-unknown')
        throw new Error('TEXT_DELIVERY_PREVIOUS_SEND_UNKNOWN');
    const next = { status, filename: String(filename || '').slice(0, 100),
        telegramMessageId: String(telegramMessageId || '').slice(0, 64),
        updatedAt: new Date().toISOString() };
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    await rename(tmp, path);
    return next;
}
