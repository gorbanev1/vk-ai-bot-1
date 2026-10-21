import { setTimeout as sleep } from 'node:timers/promises';

export async function parseVkPhotoUploadResponse(response) {
    const body = await response.text();
    if (!response.ok) {
        // A gateway's HTML body is not a JSON protocol error. Preserve HTTP
        // status for retry decisions and diagnostics without dumping its page.
        const error = new Error(`Сервер загрузки VK ответил HTTP ${response.status}.`);
        error.status = response.status;
        error.code = 'VK_UPLOAD_HTTP_ERROR';
        throw error;
    }
    try {
        return JSON.parse(body);
    } catch (cause) {
        const error = new Error(`Сервер загрузки VK вернул не JSON (HTTP ${response.status}).`, { cause });
        error.status = response.status;
        error.code = 'VK_UPLOAD_INVALID_RESPONSE';
        throw error;
    }
}

export function isRetryableVkPhotoUpload(error) {
    if (['OPERATION_TIMEOUT', 'OPERATION_CANCELLED'].includes(error?.code) || error?.name === 'AbortError') return false;
    const status = Number(error?.status ?? error?.statusCode ?? error?.cause?.status);
    if (status >= 400) return status === 429 || status >= 500 && status <= 599;
    return error?.name === 'TimeoutError' ||
        /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR_/u.test(String(error?.code || error?.cause?.code || '')) ||
        /fetch failed|Bad Gateway|Gateway Timeout|socket hang up/iu.test(String(error?.message || ''));
}

// Repeat only upload/save, never paid image generation or messages.send.
// Each attempt must obtain a fresh upload URL. All failures leave the PNG.
export async function retryVkPhotoUpload(upload, {
    signal, delaysMs = [5_000, 15_000],
    wait = (ms, options) => sleep(ms, undefined, options), onRetry = () => {},
} = {}) {
    for (let attempt = 0; ; attempt += 1) {
        signal?.throwIfAborted();
        try {
            return await upload();
        } catch (error) {
            signal?.throwIfAborted();
            if (attempt >= delaysMs.length || !isRetryableVkPhotoUpload(error)) throw error;
            try { onRetry({ error, attempt: attempt + 1, delayMs: delaysMs[attempt] }); } catch { /* telemetry only */ }
            await wait(delaysMs[attempt], { signal });
        }
    }
}
