import { parseVkPhotoUploadResponse, validateVkPhotoUploadResult } from './vkPhotoUploadRecovery.js';

export function vkPhotoAttachment(saved) {
    const photo = Array.isArray(saved) ? saved[0] : saved;
    const ownerId = Number(photo?.owner_id ?? photo?.ownerId);
    const id = Number(photo?.id);
    if (!Number.isSafeInteger(ownerId) || ownerId === 0 || !Number.isSafeInteger(id) || id <= 0) return '';
    const accessKey = String(photo?.access_key ?? photo?.accessKey ?? '');
    if (accessKey && !/^[\w-]+$/u.test(accessKey)) return '';
    return `photo${ownerId}_${id}${accessKey ? `_${accessKey}` : ''}`;
}

// One attempt. The caller owns the existing retry/backoff budget.
// Always request a fresh server for the actual destination, never reuse or edit an upload URL.
export async function uploadVkMessagePhotoOnce({
    client, buffer, filename = 'image.png', mimeType = 'image/png', peerId,
    signal, fetchImpl = fetch, onAttempt = () => {},
}) {
    signal?.throwIfAborted();
    const peer = Number(peerId);
    const parameters = Number.isSafeInteger(peer) && peer !== 0 ? { peer_id: peer } : {};
    let stage = 'get-server';
    let uploadHost = '';
    let uploadServerId = null;
    const report = event => { try { onAttempt(event); } catch { /* telemetry cannot retry a successful upload */ } };
    try {
        const server = await client.api.photos.getMessagesUploadServer(parameters);
        signal?.throwIfAborted();
        const url = new URL(server?.upload_url ?? server?.uploadUrl ?? '');
        if (url.protocol !== 'https:') throw Object.assign(new Error('VK вернул некорректный адрес загрузки.'), { code: 'VK_UPLOAD_INVALID_SERVER' });
        uploadHost = url.hostname;
        uploadServerId = Number(url.pathname.match(/^\/c(\d+)\//u)?.[1]) || null;
        stage = 'upload';
        const form = new FormData();
        form.append('photo', new Blob([buffer], { type: mimeType }), filename);
        const uploadSignal = signal ? AbortSignal.any([AbortSignal.timeout(45_000), signal]) : AbortSignal.timeout(45_000);
        const response = await fetchImpl(url.href, { method: 'POST', body: form, signal: uploadSignal });
        const payload = validateVkPhotoUploadResult(await parseVkPhotoUploadResponse(response));
        uploadServerId = payload.server;
        signal?.throwIfAborted();
        stage = 'save';
        const saved = await client.api.photos.saveMessagesPhoto(payload);
        const attachment = vkPhotoAttachment(saved);
        if (!attachment) throw Object.assign(new Error('VK не вернул идентификатор сохранённой фотографии.'), { code: 'VK_UPLOAD_SAVE_INVALID' });
        report({ status: 'saved', stage, peerId: parameters.peer_id || null, uploadHost, uploadServerId });
        return attachment;
    } catch (error) {
        error.uploadStage = stage;
        error.uploadHost = uploadHost;
        error.uploadServerId = uploadServerId;
        report({ status: 'failed', stage, peerId: parameters.peer_id || null, uploadHost, uploadServerId, code: error.code || null, httpStatus: error.status || null });
        throw error;
    }
}
