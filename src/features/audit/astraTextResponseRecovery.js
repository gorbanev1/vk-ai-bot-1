// Durable, GET-only recovery of a previously created Responses text result.
// This module must never call POST /responses or infer that a partial SSE answer is complete.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const LEGACY_TEXT_JOB_ID = 'd0e42598-b6f5-4c34-8e8b-c7e51877b144';
export const LEGACY_TEXT_RESPONSE_ID = 'resp_0b3d23c37cd3774e016aae992d1b8c87d292ed5ecc668b6ffa';
const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const validResponseId = (value) => /^resp_[a-z0-9_-]{12,160}$/iu.test(String(value || ''));

async function json(path) {
    try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}
async function persist(path, state) {
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
}
export async function saveTextJobRecipient({ root = resolve(process.env.GIGORAVE_TEXT_DATA_DIR || 'data', 'astra-text-jobs'), jobId,
    chatId, filename, model }) {
    if (!/^[a-f0-9-]{36}$/iu.test(String(jobId)) || !String(chatId).trim()) {
        throw new Error('TEXT_RECOVERY_INVALID_JOB_RECIPIENT');
    }
    const directory = join(root, jobId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const manifest = { jobId, chatId: String(chatId), filename: String(filename || 'document.txt').slice(0, 160),
        model: String(model || ''), savedAt: new Date().toISOString() };
    await persist(join(directory, 'recipient.json'), manifest);
}

// Mark a normally completed Telegram delivery so startup recovery does not
// send the same completed TXT again. Delivery may still be ambiguous if the
// process dies after Telegram accepts it but before this checkpoint is saved.
export async function markTextJobDelivered({ root = resolve(process.env.GIGORAVE_TEXT_DATA_DIR || 'data', 'astra-text-jobs'), jobId, stage = 'full', telegramMessageId = '' }) {
    if (!/^[a-f0-9-]{36}$/iu.test(String(jobId)) || !['full', 'whole-file'].includes(stage)) return false;
    const statePath = join(root, jobId, stage, 'state.json');
    const state = await json(statePath);
    if (!state || state.status !== 'completed' || !state.outputSha256) return false;
    await persist(statePath, { ...state, deliveryStatus: 'delivered', deliveredAt: new Date().toISOString(),
        telegramMessageId: String(telegramMessageId || '') });
    return true;
}

// fetchResponse({responseId, state, jobId}) returns the actual GET /responses/:id JSON.
// deliver({chatId, filename, text, jobId, responseId}) sends an actual Telegram document.
export async function recoverTextResponseJobs({
    root = resolve(process.env.GIGORAVE_TEXT_DATA_DIR || 'data', 'astra-text-jobs'), ownerChatId = '', fetchResponse, deliver,
    notify = async () => {}, wait = sleep, pollIntervalMs = 15_000, maxPolls = 480,
    legacyJobId = LEGACY_TEXT_JOB_ID, legacyResponseId = LEGACY_TEXT_RESPONSE_ID,
    previousProcessCutoffMs = Number.POSITIVE_INFINITY,
}) {
    if (typeof fetchResponse !== 'function' || typeof deliver !== 'function') throw new TypeError('Recovery requires GET and Telegram delivery');
    const report = async (event) => { try { await notify(event); } catch {} };
    let dirs = [];
    try { dirs = (await readdir(root, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    // V188.124 did not store a recipient manifest. This one specifically identified
    // user-requested old response can be recovered to the configured owner ONLY.
    if (ownerChatId && validResponseId(legacyResponseId) && !dirs.includes(legacyJobId)) {
        const directory = join(root, legacyJobId, 'full');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await persist(join(directory, 'state.json'), { stage: 'full', status: 'unknown',
            jobId: legacyJobId, responseId: legacyResponseId, model: 'gpt-6-astra', legacyRecovery: true });
        dirs.push(legacyJobId);
    }
    const results = [];
    for (const jobId of dirs) {
        if (!/^[a-f0-9-]{36}$/iu.test(jobId)) continue;
        const rootPath = join(root, jobId);
        const recipient = await json(join(rootPath, 'recipient.json'));
        const legacy = jobId === legacyJobId;
        const chatId = recipient?.chatId || (legacy ? String(ownerChatId || '') : '');
        if (!chatId) continue;
        let stageDirs = [];
        try { stageDirs = (await readdir(rootPath, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name); }
        catch { continue; }
        for (const stage of stageDirs) {
            if (!['full', 'whole-file'].includes(stage)) continue; // per-part results must never masquerade as a final complete analysis
            const dir = join(rootPath, stage);
            const statePath = join(dir, 'state.json');
            let state = await json(statePath);
            if (legacy && state && !state.responseId && !state.deliveryStatus && state.status !== 'delivered') {
                state = { ...state, responseId: legacyResponseId, model: 'gpt-6-astra', legacyRecovery: true };
                await persist(statePath, state);
            }
            // Never claim an operation started in the current process.
            if (state?.startedAt && Date.parse(state.startedAt) >= previousProcessCutoffMs) continue;
            if (!state || state.deliveryStatus === 'delivered' || state.status === 'delivered' ||
                ['unavailable', 'failed', 'cancelled', 'canceled', 'incomplete'].includes(state.recoveryStatus)) continue;
            // A completed Telegram send may have been acknowledged in delivery.json
            // before the stage checkpoint was updated. Never resend an ambiguous send.
            const delivery = await json(join(rootPath, 'delivery.json'));
            if (['accepted', 'sending-unknown'].includes(String(delivery?.status || '')) ||
                state.deliveryStatus === 'sending-unknown') {
                await report({ stage: 'delivery-not-repeated', jobId, responseId: state.responseId,
                    status: delivery?.status || state.deliveryStatus, chatId });
                continue;
            }
            // Do not take over a still-running active request from the same process.
            if (state.status === 'request-started' && !state.responseId) continue;
            if (!validResponseId(state.responseId) && state.status !== 'completed' && state.deliveryStatus !== 'ready') continue;
            if (legacy && state.responseId && state.responseId !== legacyResponseId && !recipient) continue;
            const responseId = state.responseId;
            const answerPath = join(dir, 'answer.txt');
            let text = '';
            if (state.status === 'completed' || state.deliveryStatus === 'ready' || state.deliveryStatus === 'sending-unknown') {
                try { text = await readFile(answerPath, 'utf8'); } catch {}
                if (state.outputSha256 && hash(text) !== state.outputSha256) {
                    await report({ stage: 'hash-mismatch', jobId, responseId });
                    continue;
                }
            }
            if (!text) {
                // Same response ID every time; transient GET errors do not create inference.
                for (let attempt = 1; attempt <= maxPolls; attempt++) {
                    let payload;
                    try { payload = await fetchResponse({ responseId, state, jobId }); }
                    catch (error) {
                        const status = Number(error?.status || 0);
                        if ([400, 401, 403, 404, 405, 410, 422].includes(status)) {
                            state = { ...state, recoveryStatus: 'unavailable', recoveryError: String(error?.message || error).slice(0, 350) };
                            await persist(statePath, state);
                            await report({ stage: 'get-unavailable', jobId, responseId, status, chatId });
                            break;
                        }
                        await report({ stage: 'get-transient-error', jobId, responseId, attempt, error: String(error?.message || error).slice(0, 200) });
                        if (attempt < maxPolls) await wait(pollIntervalMs);
                        continue;
                    }
                    const resultStatus = String(payload?.status || '').toLowerCase();
                    if (resultStatus === 'completed') {
                        text = String(payload?.output_text || (Array.isArray(payload?.output) ? payload.output.flatMap((item) => item?.content || []).map((part) => String(part?.text || '')).join('') : '')).trim();
                        if (!text) await report({ stage: 'completed-without-text', jobId, responseId, chatId });
                        break;
                    }
                    if (['failed', 'cancelled', 'canceled', 'incomplete'].includes(resultStatus)) {
                        state = { ...state, recoveryStatus: resultStatus };
                        await persist(statePath, state);
                        await report({ stage: 'remote-failed', jobId, responseId, status: resultStatus, chatId });
                        break;
                    }
                    if (attempt === 1 || attempt % 4 === 0) await report({ stage: 'polling', jobId, responseId, status: resultStatus || 'unknown', attempt });
                    if (attempt < maxPolls) await wait(pollIntervalMs);
                }
                if (!text) {
                    if (!['unavailable', 'failed', 'cancelled', 'canceled', 'incomplete'].includes(state.recoveryStatus)) {
                        await report({ stage: 'poll-exhausted', jobId, responseId, chatId, attempts: maxPolls });
                    }
                    continue;
                }
                await writeFile(answerPath, text, { mode: 0o600 });
                state = { ...state, status: 'completed', recoveryStatus: 'completed', responseId,
                    deliveryStatus: 'ready', outputSha256: hash(text), outputChars: text.length };
                await persist(statePath, state);
            }
            if (!text.trim()) continue;
            // Persist the complete TXT before attempting a potentially ambiguous Telegram send.
            state = { ...state, deliveryStatus: 'sending-unknown' };
            await persist(statePath, state);
            try {
                const result = await deliver({ chatId, filename: recipient?.filename || 'GIGORAVE_V188124_ALL_EVENT_SOURCE_AND_ASTRA_REVIEW_RU.txt',
                    text, jobId, responseId, stage });
                state = { ...state, status: 'delivered', deliveryStatus: 'delivered', telegramMessageId: String(result?.telegramMessage?.message_id ?? result?.message_id ?? result?.conversationMessageId ?? ''), deliveredAt: new Date().toISOString() };
                await persist(statePath, state);
                await report({ stage: 'delivered', jobId, responseId, chatId, bytes: Buffer.byteLength(text) });
                results.push({ jobId, responseId, delivered: true });
            } catch (error) {
                await report({ stage: 'delivery-failed', jobId, responseId, chatId, error: String(error?.message || error).slice(0, 250) });
            }
        }
    }
    return results;
}
