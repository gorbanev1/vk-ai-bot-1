import {
    executeRuntimeModelFailover,
    isTechnicalModelFailure,
} from './modelProviderFailover.js';

import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

const DEFAULT_MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const MAX_RECURSION_DEPTH = 10;

function clean(value) {
    return String(value ?? '').trim();
}

function normalizeTranscript(value) {
    return clean(value)
        .replace(/\r\n?/gu, '\n')
        .replace(/[ \t]+\n/gu, '\n')
        .replace(/\n[ \t]+/gu, '\n')
        .replace(/\n{3,}/gu, '\n\n')
        .replace(/[ \t]{2,}/gu, ' ')
        .trim();
}

function toPlainObject(value) {
    if (!value || typeof value !== 'object') return value;

    if (typeof value.toJSON === 'function') {
        try {
            const json = value.toJSON();
            if (json && typeof json === 'object') return json;
        } catch {
            // vk-io attachment can be only partially hydrated.
        }
    }

    return value;
}

function firstDefined(object, keys) {
    if (!object || typeof object !== 'object') return undefined;
    for (const key of keys) {
        if (object[key] !== undefined && object[key] !== null) return object[key];
    }
    return undefined;
}

function hashKey(parts) {
    return createHash('sha256')
        .update(parts.map((part) => clean(part)).join('|'))
        .digest('hex');
}

function normalizeVkAttachmentType(attachment) {
    const source = toPlainObject(attachment);
    const explicit = clean(
        source?.type ?? source?.attachmentType ?? source?.kind,
    ).toLowerCase().replace(/-/gu, '_');
    if (explicit) return explicit;

    for (const type of ['audio_message', 'voice', 'doc', 'document', 'wall', 'wall_reply']) {
        if (source?.[type] != null) return type;
    }
    return '';
}

function unwrapVkAttachment(attachment, type) {
    const source = toPlainObject(attachment);
    if (!source || typeof source !== 'object') return {};

    if (source[type] && typeof source[type] === 'object') {
        return toPlainObject(source[type]);
    }
    if (type === 'document' && source.doc && typeof source.doc === 'object') {
        return toPlainObject(source.doc);
    }
    if (source.payload && typeof source.payload === 'object') {
        return toPlainObject(source.payload);
    }
    return source;
}

function extractVkVoicePayload(type, payload) {
    if (!payload || typeof payload !== 'object') return null;

    if (type === 'audio_message' || type === 'voice') return payload;

    if (type === 'doc' || type === 'document') {
        const preview = toPlainObject(payload.preview);
        return toPlainObject(
            preview?.audio_msg ??
            preview?.audio_message ??
            preview?.voice ??
            payload.audio_msg ??
            payload.audio_message ??
            null,
        );
    }

    return null;
}

function createVkVoiceDescriptor({ type, payload, voicePayload, isDirect, path }) {
    const ownerId = Number(firstDefined(payload, ['owner_id', 'ownerId']) ?? firstDefined(voicePayload, ['owner_id', 'ownerId']) ?? 0) || 0;
    const id = Number(firstDefined(payload, ['id', 'doc_id', 'docId']) ?? firstDefined(voicePayload, ['id', 'audio_message_id', 'audioMessageId']) ?? 0) || 0;
    const accessKey = clean(firstDefined(payload, ['access_key', 'accessKey']) ?? firstDefined(voicePayload, ['access_key', 'accessKey']));
    const transcript = normalizeTranscript(firstDefined(voicePayload, [
        'transcript',
        'transcript_text',
        'transcriptText',
        'recognized_text',
        'recognizedText',
    ]));
    const transcriptState = clean(firstDefined(voicePayload, [
        'transcript_state',
        'transcriptState',
        'recognition_state',
        'recognitionState',
    ])).toLowerCase();
    const mp3Url = clean(firstDefined(voicePayload, ['link_mp3', 'linkMp3', 'mp3_url', 'mp3Url']));
    const oggUrl = clean(firstDefined(voicePayload, ['link_ogg', 'linkOgg', 'ogg_url', 'oggUrl']));
    const url = mp3Url || oggUrl || clean(firstDefined(voicePayload, ['url', 'link']));
    const duration = Number(firstDefined(voicePayload, ['duration', 'duration_seconds', 'durationSeconds']) ?? 0) || 0;
    const attachmentKey = ownerId && id
        ? `vk:${ownerId}:${id}${accessKey ? `:${accessKey}` : ''}`
        : `vk:sha256:${hashKey([url, transcript, path])}`;

    return {
        platform: 'vk',
        type: type === 'doc' || type === 'document' ? 'audio_message_doc' : 'audio_message',
        attachmentKey,
        ownerId,
        id,
        accessKey,
        transcript,
        transcriptState,
        url,
        mp3Url,
        oggUrl,
        duration,
        isDirect: Boolean(isDirect),
        path,
        mimeType: mp3Url ? 'audio/mpeg' : 'audio/ogg',
        filename: mp3Url ? 'vk-voice.mp3' : 'vk-voice.ogg',
    };
}

/**
 * Recursively finds VK voice/audio_message attachments, including forwarded
 * messages, replies, wall reposts and doc.preview.audio_msg.
 */
export function collectVkVoiceAttachments(rawMessage) {
    const output = [];
    const seenKeys = new Set();
    const visited = new WeakSet();

    const addDescriptor = (descriptor) => {
        if (!descriptor || seenKeys.has(descriptor.attachmentKey)) return;
        seenKeys.add(descriptor.attachmentKey);
        output.push(descriptor);
    };

    const visitAttachmentList = (attachments, { depth = 0, isDirect = false, path = 'attachments' } = {}) => {
        if (depth > MAX_RECURSION_DEPTH || attachments == null) return;
        const list = Array.isArray(attachments) ? attachments : [attachments];

        for (let index = 0; index < list.length && index < 60; index += 1) {
            const attachment = toPlainObject(list[index]);
            if (!attachment || typeof attachment !== 'object') continue;
            const type = normalizeVkAttachmentType(attachment);
            const payload = unwrapVkAttachment(attachment, type);
            const voicePayload = extractVkVoicePayload(type, payload);
            const attachmentPath = `${path}[${index}]`;

            if (voicePayload) {
                addDescriptor(createVkVoiceDescriptor({
                    type,
                    payload,
                    voicePayload,
                    isDirect,
                    path: attachmentPath,
                }));
            }

            if (type === 'wall') {
                visitObject(payload, {
                    depth: depth + 1,
                    isDirect: false,
                    path: `${attachmentPath}.wall`,
                });
            } else if (type === 'wall_reply') {
                visitObject(payload, {
                    depth: depth + 1,
                    isDirect: false,
                    path: `${attachmentPath}.wall_reply`,
                });
            } else if (type === 'doc' || type === 'document') {
                // A doc may contain nested payload wrappers from vk-io/API.
                const nestedAttachments = firstDefined(payload, ['attachments', 'attachment']);
                if (nestedAttachments) {
                    visitAttachmentList(nestedAttachments, {
                        depth: depth + 1,
                        isDirect: false,
                        path: `${attachmentPath}.doc.attachments`,
                    });
                }
            }
        }
    };

    const visitObject = (value, { depth = 0, isDirect = false, path = 'message' } = {}) => {
        const source = toPlainObject(value);
        if (depth > MAX_RECURSION_DEPTH || !source || typeof source !== 'object') return;
        if (visited.has(source)) return;
        visited.add(source);

        if (Array.isArray(source)) {
            source.slice(0, 60).forEach((item, index) => visitObject(item, {
                depth: depth + 1,
                isDirect: false,
                path: `${path}[${index}]`,
            }));
            return;
        }

        visitAttachmentList(firstDefined(source, ['attachments', 'attachment']), {
            depth: depth + 1,
            isDirect,
            path: `${path}.attachments`,
        });

        const reply = firstDefined(source, ['reply_message', 'replyMessage', 'reply_to_message', 'replyToMessage']);
        if (reply) {
            visitObject(reply, {
                depth: depth + 1,
                isDirect: false,
                path: `${path}.reply`,
            });
        }

        const forwarded = firstDefined(source, ['fwd_messages', 'fwdMessages', 'forwarded_messages', 'forwardedMessages']);
        if (Array.isArray(forwarded)) {
            forwarded.slice(0, 40).forEach((item, index) => visitObject(item, {
                depth: depth + 1,
                isDirect: false,
                path: `${path}.fwd[${index}]`,
            }));
        }

        const copyHistory = firstDefined(source, ['copy_history', 'copyHistory']);
        if (Array.isArray(copyHistory)) {
            copyHistory.slice(0, 30).forEach((item, index) => visitObject(item, {
                depth: depth + 1,
                isDirect: false,
                path: `${path}.copy_history[${index}]`,
            }));
        }
    };

    visitObject(rawMessage, { depth: 0, isDirect: true, path: 'message' });
    return output;
}

export function collectTelegramVoiceAttachments(message, { includeReply = true } = {}) {
    const output = [];
    const visited = new WeakSet();

    const visit = (value, { isDirect = false, path = 'message', depth = 0 } = {}) => {
        if (depth > 4 || !value || typeof value !== 'object') return;
        if (visited.has(value)) return;
        visited.add(value);

        const voice = value.voice;
        if (voice?.file_id) {
            const fileUniqueId = clean(voice.file_unique_id);
            const fileId = clean(voice.file_id);
            output.push({
                platform: 'telegram',
                type: 'voice',
                attachmentKey: fileUniqueId
                    ? `telegram:${fileUniqueId}`
                    : `telegram:file:${hashKey([fileId])}`,
                fileId,
                fileUniqueId,
                duration: Number(voice.duration ?? 0) || 0,
                mimeType: clean(voice.mime_type) || 'audio/ogg',
                fileSize: Number(voice.file_size ?? 0) || 0,
                isDirect: Boolean(isDirect),
                path,
                filename: 'telegram-voice.ogg',
                transcript: normalizeTranscript(voice.transcript),
            });
        }

        if (includeReply && value.reply_to_message) {
            visit(value.reply_to_message, {
                isDirect: false,
                path: `${path}.reply`,
                depth: depth + 1,
            });
        }
    };

    visit(message, { isDirect: true, path: 'message', depth: 0 });
    return output;
}

export function formatVoiceTranscriptBlock(transcripts, {
    platform = '',
    directOnly = false,
} = {}) {
    const lines = [];
    const seen = new Set();
    for (const item of Array.isArray(transcripts) ? transcripts : []) {
        if (directOnly && !item?.isDirect) continue;
        const text = normalizeTranscript(item?.transcript ?? item?.text);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        const label = item?.isDirect
            ? '[Голосовое сообщение]'
            : `[Голосовое во вложении${platform ? ` ${platform.toUpperCase()}` : ''}]`;
        lines.push(`${label}\n${text}`);
    }
    return lines.join('\n\n').trim();
}

export async function transcribeAudioBuffer({
    buffer,
    filename = 'voice.ogg',
    mimeType = 'audio/ogg',
    providers = [],
    fetchImpl = fetch,
    timeoutMs = 45_000,
    maxBytes = DEFAULT_MAX_AUDIO_BYTES,
} = {}) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
        throw new Error('Пустой audio buffer.');
    }
    if (buffer.length > maxBytes) {
        throw new Error(`Голосовое слишком большое для распознавания: ${buffer.length} байт.`);
    }

    const candidates = (Array.isArray(providers) ? providers : [])
        .map((provider, index) => ({
            provider: 'stt',
            name: clean(provider?.name) || `stt-key-${index + 1}`,
            secret: clean(provider?.apiKey),
            baseUrl: clean(provider?.baseUrl).replace(/\/$/u, ''),
            models: Array.isArray(provider?.models)
                ? provider.models.map(clean).filter(Boolean)
                : [clean(provider?.model)].filter(Boolean),
        }))
        .filter((provider) => provider.secret && provider.baseUrl && provider.models.length);

    if (!candidates.length) {
        throw new Error('Не настроен ни один speech-to-text endpoint.');
    }

    const result = await executeRuntimeModelFailover({
        candidates,
        shouldRetry(error) {
            const message = clean(error?.message || error);
            return isTechnicalModelFailure(error) ||
                /\b(?:400|404|422)\b/iu.test(message) &&
                /(?:model|audio|transcrib|whisper|unsupported|not\s+found|unknown)/iu.test(message);
        },
        request: async (credential) => {
            let lastError = null;

            for (const model of credential.models) {
                try {
                    const form = new FormData();
                    form.append('model', model);
                    form.append('response_format', 'json');
                    form.append(
                        'file',
                        new Blob([buffer], { type: mimeType || 'application/octet-stream' }),
                        filename || 'voice.ogg',
                    );
                    const response = await fetchImpl(`${credential.baseUrl}/audio/transcriptions`, {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${credential.secret}` },
                        body: form,
                        signal: AbortSignal.timeout(timeoutMs),
                    });
                    const bodyText = await response.text();
                    let payload = null;
                    try {
                        payload = JSON.parse(bodyText);
                    } catch {
                        payload = null;
                    }
                    const transcript = normalizeTranscript(
                        payload?.text ?? payload?.transcript ?? (response.ok ? bodyText : ''),
                    );
                    if (!response.ok || !transcript) {
                        const detail = normalizeTranscript(
                            payload?.error?.message ?? payload?.message ?? bodyText,
                        ).slice(0, 500);
                        const failure = new Error(
                            `${credential.name} ${model}: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`,
                        );
                        failure.status = response.status;
                        throw failure;
                    }
                    return {
                        text: transcript,
                        model,
                        provider: credential.name,
                    };
                } catch (error) {
                    lastError = error;
                    const message = clean(error?.message || error);
                    const modelCompatibilityFailure = /\b(?:400|404|422)\b/iu.test(message) &&
                        /(?:model|audio|transcrib|whisper|unsupported|not\s+found|unknown)/iu.test(message);
                    if (!modelCompatibilityFailure) throw error;
                }
            }

            throw lastError || new Error(`${credential.name}: ни одна STT-модель не сработала.`);
        },
        onEvent(event) {
            if (event.type === 'rotate') {
                console.warn(
                    '[STT KEY ROTATE]',
                    `key=${event.credential?.name || 'unknown'}`,
                    'reason=three-failures',
                );
            } else if (event.type === 'success' && (event.attempt > 1 || event.round > 1)) {
                console.log(
                    '[STT FAILOVER RECOVERED]',
                    `key=${event.credential?.name || 'unknown'}`,
                    `attempt=${event.attempt}`,
                    `round=${event.round}`,
                );
            }
        },
    });

    return result.value;
}

export { normalizeTranscript as normalizeVoiceTranscript };
