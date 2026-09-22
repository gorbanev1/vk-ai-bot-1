/** One-shot Cloudflare/router diagnostics. Never retries an AI POST or logs keys/model text. */
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { runBodyProbe, runH2PingProbe, runWsProbe, runAsyncProbe } from './cloudflareProbeModes.js';

const SAFE_PROBE_MS = 210_000;
const LIVE_PROBE_MS = 210_000; // Explicit diagnostic deadline, never used for production TXT jobs.
const notifyIntervalMs = 30_000;
const now = () => Date.now();
export const CF_PROBE_HELP = [
    '🔍 Проверка Cloudflare и AI-роутера (лично владельцу):',
    '/cfprobe help — эта справка',
    '/cfprobe stream — тестовый SSE endpoint из CF_PROBE_STREAM_URL',
    '/cfprobe sync — тестовый endpoint из CF_PROBE_SYNC_URL',
    '/cfprobe body — тестовый POST с порциями тела запроса (НЕ heartbeat ответа)',
    '/cfprobe h2ping — HTTP/2 PING на тестовом соединении (НЕ heartbeat ответа)',
    '/cfprobe ws — проба WebSocket только на тестовом endpoint',
    '/cfprobe async — проверка тестового job ID без второго POST',
    '/cfprobe all — все БЕСПЛАТНЫЕ режимы по очереди; ненастроенные пропускаются',
    '/cfprobe live-stream ПОДТВЕРЖДАЮ — ОДИН возможный платный короткий AI-запрос через действующий роутер',
    '/cfprobe live-stream-long ПОДТВЕРЖДАЮ — ОДИН потенциально дорогой длинный запрос; не гарантия 180 с',
    '/cfprobe all-live ПОДТВЕРЖДАЮ — ДВА возможных платных запроса (stream и non-stream), последовательно',
    '/cfprobe status — статус текущей проверки; /cfprobe stop — прервать ожидание теста',
    '/cfprobe log — получить текстовый лог последней проверки',
    'Тестовый endpoint должен быть предварительно создан на стороне сервера.',
    'body/h2ping/ws не отправляют байты ответа AI и не сбрасывают Cloudflare Proxy Read Timeout.',
    'Тест не встраивается в существующий запрос TXT и не возобновляет его.',
].join('\n');

export function parseCfProbeCommand(input) {
    const match = String(input ?? '').trim().match(/^\/cfprobe(?:@[a-zA-Z0-9_]+)?(?:\s+(.*))?$/iu);
    return match ? String(match[1] || 'help').trim() : null;
}

function endpoint(value) {
    if (!value) return null;
    try {
        const url = new URL(String(value));
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) return null;
        if (url.username || url.password || url.hash) return null;
        return url;
    } catch { return null; }
}

export async function runCloudflareProbe({ url, payload, headers = {}, method = 'POST', fetchImpl = fetch,
    durationMs = SAFE_PROBE_MS, send = async () => {}, log = async () => {}, signal = null,
    expectSse = true, bodyOverride = null }) {
    const probeUrl = endpoint(url);
    if (!probeUrl) return { status: 'SKIPPED', reason: 'Тестовый URL не указан или небезопасен.' };
    const id = `cfprobe-${randomUUID()}`;
    const started = now();
    const boundedDuration = Math.min(240_000, Math.max(10_000, Number(durationMs) || SAFE_PROBE_MS));
    const timerController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; timerController.abort(new Error('CFPROBE_DIAGNOSTIC_DEADLINE')); }, boundedDuration);
    const stop = () => timerController.abort(new Error('CFPROBE_OWNER_CANCELLED'));
    signal?.addEventListener('abort', stop, { once: true });
    const summary = { id, status: 'UNKNOWN', httpStatus: null, headersMs: null, firstByteMs: null, lastByteMs: null, idleMs: null,
        maxByteGapMs: 0, bytes: 0, sseEvents: 0, heartbeatEvents: 0, modelDataEvents: 0, completed: false,
        elapsedMs: 0, lastActivity: null };
    let lastByte = started;
    let lastNotice = started;
    let buffered = '';
    const decoder = new TextDecoder();
    let eventsSeen = false;
    let doneMarker = false;
    const record = async (event, info = '') => { await log(`[${new Date().toISOString()}] ${id} ${event}${info ? ' ' + info : ''}`); };
    const report = async message => { try { await send(message); } catch { await record('telegram-notify-error'); } };
    const watch = setInterval(() => {
        if (now() - lastNotice < notifyIntervalMs) return;
        lastNotice = now();
        void report(`🔍 /cfprobe: ${Math.round((now() - started) / 1000)} с; без байтов ${Math.round((now() - lastByte) / 1000)} с; heartbeat ${summary.heartbeatEvents}; событий ${summary.sseEvents}.`).catch(() => {});
    }, notifyIntervalMs);
    function acceptSse(frame) {
        const lines = frame.split('\n');
        if (lines.every(line => !line || line.startsWith(':'))) {
            summary.heartbeatEvents++;
            void record('sse-heartbeat', `total=${summary.heartbeatEvents}`).catch(() => {});
            return;
        }
        const dataLines = lines.filter(line => line.startsWith('data:'));
        if (dataLines.length) {
            const data = dataLines.map(line => line.slice(5).trim()).join('\n');
            if (data === '[DONE]') { doneMarker = true; summary.completed = true; }
            else {
                summary.modelDataEvents++;
                try {
                    const parsed = JSON.parse(data);
                    if (parsed?.type === 'response.completed' || parsed?.event === 'response.completed' ||
                        parsed?.event === 'completed') summary.completed = true;
                } catch { /* Some routers send non-JSON data frames. */ }
            }
        }
        if (lines.some(line => /^event:\s*(?:response\.completed|completed)\s*$/u.test(line))) summary.completed = true;
    }
    try {
        await record('started', `method=${method} host=${probeUrl.host} durationSec=${Math.round(boundedDuration / 1000)}`);
        const requestHeaders = { accept: 'text/event-stream', 'cache-control': 'no-cache', 'x-client-request-id': id, ...headers };
        const response = await fetchImpl(probeUrl.toString(), { method, headers: requestHeaders,
            body: method === 'GET' ? undefined : (bodyOverride || JSON.stringify(payload ?? { probe: true, stream: true })),
            ...(bodyOverride ? { duplex: 'half' } : {}),
            signal: timerController.signal, redirect: 'error' });
        summary.httpStatus = response.status;
        summary.headersMs = now() - started;
        await record('http-headers', `status=${response.status} contentType=${String(response.headers?.get?.('content-type') || '-').slice(0, 120)}`);
        if (!response.ok) {
            summary.status = 'HTTP_ERROR';
            // Intentionally do not log or echo provider error body: it may contain secrets or prompt text.
            return summary;
        }
        if (!response.body) { summary.status = 'NO_RESPONSE_BODY'; return summary; }
        const reader = response.body.getReader();
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value?.byteLength) continue;
            const at = now();
            const gap = at - lastByte;
            summary.maxByteGapMs = Math.max(summary.maxByteGapMs, gap);
            lastByte = at;
            summary.bytes += value.byteLength;
            summary.lastByteMs = at - started;
            summary.lastActivity = new Date(at).toISOString();
            if (summary.firstByteMs === null) summary.firstByteMs = at - started;
            await record('response-bytes', `count=${value.byteLength} gapMs=${gap} total=${summary.bytes}`);
            if (!expectSse) continue;
            buffered = (buffered + decoder.decode(value, { stream: true })).replace(/\r\n/gu, '\n');
            if (buffered.length > 256_000) { summary.status = 'SSE_FRAME_TOO_LARGE'; break; }
            let end;
            while ((end = buffered.indexOf('\n\n')) >= 0) {
                const frame = buffered.slice(0, end);
                buffered = buffered.slice(end + 2);
                if (!frame) continue;
                summary.sseEvents++;
                eventsSeen = true;
                acceptSse(frame);
            }
        }
        summary.status = summary.status === 'SSE_FRAME_TOO_LARGE' ? summary.status
            : !expectSse ? 'COMPLETED_HTTP'
            : summary.completed ? 'COMPLETED' : eventsSeen ? 'UNKNOWN_STREAM_END' : 'UNKNOWN_NO_SSE_EVENTS';
        if (doneMarker) await record('sse-done');
        return summary;
    } catch (error) {
        summary.status = timedOut ? 'PROBE_DEADLINE' : 'UNKNOWN_EXCEPTION';
        summary.error = String(error?.name || 'NetworkError').slice(0, 60);
        await record('exception', `status=${summary.status} errorType=${summary.error}`);
        return summary;
    } finally {
        clearTimeout(timer); clearInterval(watch);
        signal?.removeEventListener('abort', stop);
        summary.elapsedMs = now() - started;
        summary.idleMs = now() - lastByte;
        summary.maxByteGapMs = Math.max(summary.maxByteGapMs, summary.idleMs);
        await record('finished', `status=${summary.status} http=${summary.httpStatus ?? '-'} elapsedMs=${summary.elapsedMs} headersMs=${summary.headersMs ?? '-'} idleMs=${summary.idleMs} firstByteMs=${summary.firstByteMs ?? '-'} maxByteGapMs=${summary.maxByteGapMs} bytes=${summary.bytes} heartbeats=${summary.heartbeatEvents} modelEvents=${summary.modelDataEvents} completed=${summary.completed}`);
    }
}

let lastLogPath = '';
let activeProbe = null;
export async function handleCfProbeCommand({ text, ownerDm, send, sendLog = null, baseUrl, apiKey, model, longModel = null, env = process.env,
    fetchImpl = fetch }) {
    const argumentsText = parseCfProbeCommand(text);
    if (argumentsText === null) return false;
    if (!ownerDm) { await send('Команда /cfprobe доступна только владельцу в личном чате Telegram.'); return true; }
    const words = argumentsText.split(/\s+/u);
    const mode = words[0]?.toLowerCase() || 'help';
    if (mode === 'help') { await send(CF_PROBE_HELP); return true; }
    if (mode === 'status') {
        await send(activeProbe ? `🔍 /cfprobe ${activeProbe.mode}: выполняется ${Math.round((now()-activeProbe.started)/1000)} с. /cfprobe log — текущий журнал; /cfprobe stop — остановить тест.` : 'Сейчас проверка /cfprobe не выполняется. /cfprobe log — последний журнал.');
        return true;
    }
    if (mode === 'stop') {
        if (activeProbe?.controller) { activeProbe.controller.abort(); await send('Запрошена остановка диагностического запроса /cfprobe. На стороне роутера вычисление может продолжиться; новых POST не будет.'); }
        else await send('Нет активной проверки /cfprobe.');
        return true;
    }
    if (mode === 'log') {
        if (!lastLogPath) { await send('Журналов /cfprobe пока нет.'); return true; }
        const logText = await readFile(lastLogPath, 'utf8');
        if (typeof sendLog === 'function') await sendLog(logText, lastLogPath);
        else await send(`Журнал проверки (начало):\n${logText.slice(0, 3000)}\nПолный файл: ${lastLogPath}`);
        return true;
    }
    if (activeProbe) { await send('Проверка /cfprobe уже идёт; второй запрос не запускаю.'); return true; }
    const live = mode === 'live-stream' || mode === 'live-stream-long' || mode === 'all-live';
    const long = mode === 'live-stream-long';
    if (live && words[1]?.toUpperCase() !== 'ПОДТВЕРЖДАЮ') {
        const costNote = mode === 'all-live' ? 'ДВА возможных платных POST' : (long ? 'ОДИН длинный и потенциально дорогой POST' : 'ОДИН потенциально платный POST');
        await send(`⚠️ Эта команда создаёт ${costNote}. Для запуска: /cfprobe ${mode} ПОДТВЕРЖДАЮ`);
        return true;
    }
    if (!['stream','sync','body','h2ping','ws','async','all','live-stream','live-stream-long','all-live'].includes(mode)) {
        await send('Режим не поддерживается в этом патче. /cfprobe help'); return true;
    }
    if (live && (!apiKey || !baseUrl || !model)) { await send('Нет конфигурации AI-роутера/ключа/модели.'); return true; }
    const logDir = resolve(env.GIGORAVE_TEXT_DATA_DIR || 'data', 'logs', 'cloudflare-probes');
    const logPath = resolve(logDir, `probe-${new Date().toISOString().replace(/[:.]/gu,'-')}-${randomUUID()}.txt`);
    await mkdir(dirname(logPath), { recursive: true });
    lastLogPath = logPath;
    const log = async line => appendFile(logPath, line + '\n', 'utf8');
    const run = async kind => {
        if (kind === 'async') return runAsyncProbe({ createUrl:env.CF_PROBE_JOB_CREATE_URL,
            statusUrlTemplate:env.CF_PROBE_JOB_STATUS_URL,fetchImpl,log,send,signal:probeController.signal });
        if (kind === 'body') return runBodyProbe({url:env.CF_PROBE_BODY_URL,
            runProbe:opts=>runCloudflareProbe({...opts,fetchImpl}),send,log,signal:probeController.signal });
        if (kind === 'h2ping') return runH2PingProbe({url:env.CF_PROBE_H2_URL,log,signal:probeController.signal});
        if (kind === 'ws') return runWsProbe({url:env.CF_PROBE_WS_URL,log,signal:probeController.signal});
        const url = live ? `${String(baseUrl).replace(/\/+$/u, '')}/chat/completions`
            : (kind === 'stream' ? env.CF_PROBE_STREAM_URL : env.CF_PROBE_SYNC_URL);
        if (!url) return { status: 'SKIPPED', reason: `CF_PROBE_${kind.toUpperCase()}_URL не задан. Тестовый endpoint не создаётся на стороне бота.` };
        const isStream = kind === 'stream';
        const payload = live ? { model: long ? (longModel || model) : model, stream: isStream, messages: [{ role: 'user', content: long ? 'Составь подробный технический анализ надёжности многочасовых AI-запросов через HTTP-прокси, с примерами протокола SSE, тайм-аутов и способов восстановления. Дай последовательное подробное описание и завершённый вывод.' : 'Техническая проверка streaming через прокси. Ответь кратко: проверка завершена.' }], max_completion_tokens: long ? 4096 : 512, ...(long ? { reasoning_effort: 'high' } : {}) }
            : { probe: true, stream: isStream, mode: kind };
        return runCloudflareProbe({ url, payload, fetchImpl, durationMs: live ? LIVE_PROBE_MS : SAFE_PROBE_MS, expectSse: isStream,
            headers: live ? { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
            send, log, signal: probeController.signal });
    };
    const probeController = new AbortController();
    activeProbe = { mode, started: now(), controller: probeController };
    try {
        await send(`🔍 Запускаю /cfprobe ${mode}. Журнал ведётся отдельно. ${live ? (mode === 'all-live' ? 'Два разных потенциально платных POST последовательно; автоматических повторов не будет.' : 'Один разрешённый потенциально платный POST; повторов не будет.') : 'Платных AI-запросов нет.'}`);
        const kinds = mode === 'all' ? ['sync','stream','body','h2ping','ws','async']
            : mode === 'all-live' ? ['stream','sync'] : [live ? 'stream' : mode];
        for (const kind of kinds) {
            const r = await run(kind);
            await log(`[${new Date().toISOString()}] result mode=${kind} status=${r.status} reason=${r.reason || '-'} http=${r.httpStatus ?? '-'} firstByteMs=${r.firstByteMs ?? '-'} maxByteGapMs=${r.maxByteGapMs ?? '-'} heartbeat=${r.heartbeatEvents ?? '-'} completed=${r.completed ?? '-'} elapsedMs=${r.elapsedMs ?? '-'}`);
            await send(`🔍 ${kind}: ${r.status}${live ? `\nЗапрошена модель: ${long ? (longModel || model) : model}` : ''}${r.reason ? '\n' + r.reason : ''}\nHTTP: ${r.httpStatus ?? '-'}; первый байт: ${r.firstByteMs === null || r.firstByteMs === undefined ? 'не получен' : Math.round(r.firstByteMs / 1000) + ' с'}; максимальная пауза: ${r.maxByteGapMs == null ? '-' : Math.round(r.maxByteGapMs / 1000) + ' с'}; heartbeat: ${r.heartbeatEvents ?? 0}; h2ping: ${r.pingCount ?? 0}; завершение: ${r.completed ? 'подтверждено' : 'не подтверждено'}.\nЛог: ${logPath}`);
        }
    } catch (error) {
        await log(`[${new Date().toISOString()}] probe-failed errorType=${String(error?.name || 'Error').slice(0,80)}`);
        try { await send('⚠️ Проверка завершилась ошибкой. Повторный POST не отправлялся. Лог: ' + logPath); } catch {}
    } finally {
        activeProbe = null;
        if (typeof sendLog === 'function') {
            try { await sendLog(await readFile(logPath, 'utf8'), logPath); }
            catch { try { await send('⚠️ Не удалось отправить журнал /cfprobe в Telegram. /cfprobe log — повторить отправку уже сохранённого файла.'); } catch {} }
        }
    }
    return true;
}
