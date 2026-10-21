import { isUsableVoiceTranscript } from './voiceTranscription.js';
import { normalizeLocalCommand } from '../../shared/commands.js';

export const VK_VOICE_DEADLINE_MS = 2 * 60 * 60 * 1000;
export const VK_VOICE_LATE_INTERVAL_MS = 10 * 60 * 1000;
export const vkVoiceInitialDelays = (random = Math.random) =>
    [40_000, 120_000, 240_000 + Math.floor(Math.min(1, Math.max(0, random())) * 60_000)];

export function parseVoiceTranscriptLogCommand(value) {
    const match = normalizeLocalCommand(value).match(/^транскрипт(?:ы)?(?: лог)?(?: (\d+))?$/u);
    return match ? { matched: true, cmid: Number(match[1]) || 0 } : { matched: false };
}

export function formatVoiceTranscriptLog(jobs, { timeZone = 'Europe/Moscow' } = {}) {
    if (!jobs.length) return 'Журнал транскриптов этой беседы пока пуст. Записываются новые голосовые после обновления бота.';
    const stamp = ms => new Date(ms).toLocaleString('ru-RU', { timeZone });
    const statuses = { pending: 'ожидание транскрипта', ready: 'транскрипт получен, ожидается обработка',
        delivering: 'транскрипт получен, ответ обрабатывается', done: 'транскрипт получен, обработка завершена',
        expired: 'транскрипт не пришёл за 2 часа', missing: 'транскрипт не пришёл после 3 запросов',
        delivery_error: 'транскрипт получен, ошибка обработки ответа', cancelled: 'ответ отменён' };
    return ['Журнал транскриптов VK', ...jobs.map(job => {
        const lines = ['ГС #' + job.cmid + ' · id' + job.senderId + ' · ' + stamp(job.receivedAt),
            'Режим: ' + ({ addressed: 'обращение к боту', autonomous: 'выбран случайный ответ', none: 'ответ не выбран' }[job.mode]) + '.',
            'Запросов к VK: ' + job.requests.length + '. Итог: ' + (statuses[job.status] || job.status) + '.'];
        if (job.successAttempt === 0) lines.push('Текст получен сразу из сообщения/кэша, без запроса к VK.');
        for (const request of job.requests) {
            const result = { sent: 'отправлен, результат ещё не записан', missing: 'текста нет',
                partial: 'получена часть транскриптов', found: 'транскрипт получен', error: 'ошибка VK' }[request.result];
            lines.push('№' + request.attempt + ': ' + stamp(request.sentAt) + ' · +' + request.elapsedSeconds +
                ' с от получения · пауза ' + request.delaySeconds + ' с → ' + result + '.');
        }
        if (job.successAttempt > 0) lines.push('Транскрипт получен на запросе №' + job.successAttempt + '.');
        if (job.unavailableAt) lines.push('Отправлено: «Голос не распознан.»');
        if (job.status === 'pending') lines.push('Следующая проверка: ' + stamp(job.nextAt) + '; предел: ' + stamp(job.deadlineAt) + '.');
        return lines.join('\n');
    })].join('\n\n');
}

/** One actual VK API call per attempt. No sleeps or AI calls without a full transcript. */
export function createVkVoiceTranscriptJobs({ store, fetchDescriptors, onReady, onUnavailable,
    now = Date.now, random = Math.random, logger = () => {} }) {
    const running = new Set();
    const complete = job => job.descriptors.length > 0 && job.descriptors.every(item => isUsableVoiceTranscript(item.transcript));
    const save = job => { store.save(job); return job; };
    const finish = async job => {
        // Claim before response code: replayed updates cannot answer twice.
        job.status = 'delivering'; save(job);
        try {
            const result = await onReady(job);
            job.status = result === false ? 'cancelled' : 'done';
        } catch (error) {
            job.status = 'delivery_error';
            logger('delivery-error', job, error);
        }
        job.finishedAt = now(); save(job); logger('finished', job);
    };
    async function processJob(job) {
        if (running.has(job.key)) return;
        running.add(job.key);
        try {
            job = store.get(job.key);
            if (job.status === 'ready') return await finish(job);
            if (job.status !== 'pending' || job.nextAt > now()) return;
            if (now() >= job.deadlineAt) {
                job.status = 'expired'; job.finishedAt = now(); save(job); logger('expired', job); return;
            }
            const previous = job.requests.at(-1)?.sentAt ?? job.receivedAt;
            const request = { attempt: job.requests.length + 1, sentAt: now(), result: 'sent' };
            request.elapsedSeconds = Math.round((request.sentAt - job.receivedAt) / 1000);
            request.delaySeconds = Math.round((request.sentAt - previous) / 1000);
            job.requests.push(request);
            // Save the next slot before I/O, so a restart won't replay this attempt.
            job.nextAt = Math.min(job.deadlineAt, request.sentAt +
                (job.delays[request.attempt] ?? VK_VOICE_LATE_INTERVAL_MS));
            save(job); logger('request', job, request);
            try {
                const fresh = await fetchDescriptors(job);
                job.descriptors = job.descriptors.map(old => {
                    const found = fresh.find(item => item.attachmentKey === old.attachmentKey);
                    return found && isUsableVoiceTranscript(found.transcript) ? { ...old, ...found, isDirect: true } : old;
                });
                request.result = complete(job) ? 'found' : job.descriptors.some(item => isUsableVoiceTranscript(item.transcript)) ? 'partial' : 'missing';
            } catch (error) {
                request.result = 'error';
                request.errorCode = String(error?.code || error?.name || 'VK_ERROR');
                logger('request-error', job, error);
            }
            request.completedAt = now(); save(job); logger('result', job, request);
            if (complete(job)) {
                job.successAttempt = request.attempt; job.status = 'ready'; job.nextAt = now(); save(job);
                return await finish(job);
            }
            if (request.attempt >= 3 && !job.initialFinishedAt) {
                job.initialFinishedAt = now(); save(job);
                if (job.mode === 'addressed') {
                    try {
                        await onUnavailable(job); job.unavailableAt = now(); save(job);
                    } catch (error) { logger('notice-error', job, error); }
                }
            }
            if (request.attempt >= 3 && job.mode === 'none') {
                job.status = 'missing'; job.finishedAt = now(); save(job); logger('missing', job);
            }
        } finally { running.delete(job.key); }
    }
    return {
        enqueue(input) {
            const key = [input.groupId, input.peerId, input.cmid].join(':');
            if (store.get(key)) return store.get(key);
            const receivedAt = now();
            const job = { ...input, key, receivedAt, deadlineAt: receivedAt + VK_VOICE_DEADLINE_MS,
                requests: [], delays: vkVoiceInitialDelays(random), status: 'pending' };
            job.nextAt = receivedAt + job.delays[0];
            if (complete(job)) { job.status = 'ready'; job.successAttempt = 0; job.nextAt = receivedAt; }
            save(job); logger('queued', job); return job;
        },
        async tick() {
            const jobs = store.due(now());
            const results = await Promise.allSettled(jobs.map(processJob));
            results.forEach((result, index) => {
                if (result.status === 'rejected') logger('job-error', jobs[index], result.reason);
            });
        },
    };
}
