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
        error.code = 'VK_UPLOAD_INVALID_JSON';
        throw error;
    }
}

export function isRetryableVkPhotoUpload(error) {
    if (['OPERATION_TIMEOUT', 'OPERATION_CANCELLED'].includes(error?.code) || error?.name === 'AbortError') return false;
    if (['VK_UPLOAD_EMPTY_PHOTO', 'VK_UPLOAD_INVALID_JSON'].includes(error?.code)) return true;
    const status = Number(error?.status ?? error?.statusCode ?? error?.cause?.status);
    if (status >= 400) return status === 405 || status === 429 || status >= 500 && status <= 599;
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

// HTTP 200 is not upload success. Never pass an empty photo to saveMessagesPhoto.
export function validateVkPhotoUploadResult(result) {
    const photo = result?.photo;
    if (typeof photo === 'string' && (!photo.trim() || photo.trim() === '[]')) {
        throw Object.assign(new Error('VK принял запрос загрузки, но не вернул фотографию.'), { code: 'VK_UPLOAD_EMPTY_PHOTO' });
    }
    if (!Number.isFinite(Number(result?.server)) || result?.server == null || typeof photo !== 'string' || !photo || typeof result?.hash !== 'string' || !result.hash) {
        throw Object.assign(new Error('VK вернул неполный результат загрузки фотографии.'), { code: 'VK_UPLOAD_INVALID_RESPONSE' });
    }
    return { server: Number(result.server), photo, hash: result.hash };
}

// Only HTTP 405 on a direct photo upload uses the independent vk-io
// multipart transport. Never retry a paid generation or messages.send.
export async function uploadVkPhotoWithSdk405Fallback(directUpload, sdkUpload, { onFallback = () => {}, retryAfterSdkFailure = null } = {}) {
    try {
        return await directUpload();
    } catch (error) {
        if (error?.code !== 'VK_UPLOAD_HTTP_ERROR' || Number(error?.status) !== 405) throw error;
        try { onFallback(error); } catch { /* diagnostics must not stop upload */ }
        try { return await sdkUpload(); } catch (sdkError) {
            // If both transports fail, retry with a fresh VK upload server; never regenerate.
            if (typeof retryAfterSdkFailure !== 'function') throw sdkError;
            return retryAfterSdkFailure(sdkError);
        }
    }
}
