import {
    executeRuntimeModelFailover,
    isTechnicalModelFailure,
} from './modelProviderFailover.js';

import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { getCurrentOperationSignal } from '../../runtime/operationSupervisor.js';
import { formatPrivateError } from '../../shared/errors.js';

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

export function isUsableVoiceTranscript(value) {
    const text = normalizeTranscript(value);
    if (!/[\p{L}\p{N}]/u.test(text)) return false;
    // Providers sometimes decorate a sentinel with a bot name or Markdown.
    if (/\[\s*(?:NO[ _-]*SPEECH|AUDIO[ _-]*UNAVAILABLE|INAUDIBLE|UNINTELLIGIBLE)\s*\]/iu.test(text)) return false;
    if (/^no speech(?: detected)?[.!]?$/iu.test(text)) return false;
    if (/^\[object Object\]$/u.test(text)) return false;
    if (/^(?:\*\*[^\n]+\*\*\s*)?(?:к сожалению[, ]*|извините[, ]*|sorry[, ]*)?(?:я\s+)?(?:не могу|не способен|не умею|i\s+(?:cannot|can['’]t)|unable to).{0,100}(?:прослуш|распозна|аудио|голос|listen|audio|voice|transcrib)/isu.test(text)) return false;
    if (/(?:i['’]?m|i am|я)\s+deepseek/iu.test(text) && /(?:internal|system|instructions|cannot|не могу)/iu.test(text)) return false;
    return true;
}

export function isReusableVoiceTranscriptCache(cached) {
    return cached?.status === 'ok'
        && cached.model !== 'configured-gpt-ladder'
        && isUsableVoiceTranscript(cached.transcript);
}

// Speech has its own credentials and models: the chat ladder/persona must never
// receive a voice as a generic input_file and claim it transcribed the audio.
export function collectVoiceTranscriptionProviders(env = process.env) {
    const providers = [];
    const models = (value, defaults) => {
        const selected = clean(value).split(/[;,]/u).map(clean).filter(Boolean);
        return selected.length ? selected : defaults;
    };
    const add = (prefix, base, defaultModels, modelPrefix = prefix.replace(/API_KEY$/u, 'MODELS')) => {
        const seen = new Set();
        for (const suffix of ['', ...Array.from({ length: 20 }, (_, index) => `_${index + 1}`)]) {
            const apiKey = clean(env[`${prefix}${suffix}`]);
            if (!apiKey || seen.has(apiKey)) continue;
            seen.add(apiKey);
            const basePrefix = prefix.replace(/API_KEY$/u, 'BASE_URL');
            providers.push({
                name: `${prefix}${suffix}`, apiKey,
                baseUrl: clean(env[`${basePrefix}${suffix}`] || env[basePrefix] || base).replace(/\/+$/u, ''),
                models: models(env[`${modelPrefix}${suffix}`] || env[modelPrefix] || env[modelPrefix.replace(/MODELS$/u, 'MODEL')], defaultModels),
            });
        }
    };
    add('AUDIO_TRANSCRIPTION_API_KEY', 'https://api.openai.com/v1', ['gpt-transcribe', 'gpt-4o-mini-transcribe']);
    add('OPENAI_API_KEY', 'https://api.openai.com/v1', ['gpt-transcribe', 'gpt-4o-mini-transcribe'], 'OPENAI_AUDIO_MODELS');
    add('GROQ_API_KEY', 'https://api.groq.com/openai/v1', ['whisper-large-v3-turbo', 'whisper-large-v3'], 'GROQ_AUDIO_MODELS');
    add('OPENAI_COMPAT_API_KEY', 'https://router.cheap/v1', ['gpt-transcribe', 'gpt-4o-mini-transcribe'], 'OPENAI_COMPAT_AUDIO_MODELS');
    return providers;
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
    const nativeTranscript = normalizeTranscript(firstDefined(voicePayload, [
        'transcript',
        'transcript_text',
        'transcriptText',
        'recognized_text',
        'recognizedText',
    ]));
    const transcript = isUsableVoiceTranscript(nativeTranscript) ? nativeTranscript : '';
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
        ? `vk:${ownerId}:${id}`
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

export function vkVoiceDescriptorsNeedTranscriptHydration(descriptors) {
    return (Array.isArray(descriptors) ? descriptors : [])
        .some((item) => !isUsableVoiceTranscript(item?.transcript));
}

export async function pollVkVoiceTranscripts({
    descriptors = [],
    fetchFreshDescriptors,
    attempts = 3,
    intervalMs = 40_000,
    wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    onAttempt = null,
} = {}) {
    const voices = new Map((Array.isArray(descriptors) ? descriptors : [])
        .filter((item) => item?.isDirect)
        .map((item) => [String(item.attachmentKey || ''), item])
        .filter(([key]) => key));
    const pending = () => [...voices.values()].filter((voice) => !isUsableVoiceTranscript(voice.transcript));

    for (let attempt = 1; attempt <= Math.max(1, Number(attempts) || 1) && pending().length; attempt += 1) {
        await wait(Math.max(0, Number(intervalMs) || 0));
        let fresh = [];
        try {
            fresh = await fetchFreshDescriptors?.({ attempt, pending: pending() }) || [];
        } catch (error) {
            onAttempt?.({ attempt, error });
            continue;
        }
        for (const descriptor of Array.isArray(fresh) ? fresh : []) {
            const key = String(descriptor?.attachmentKey || '');
            const previous = voices.get(key);
            if (!previous) continue;
            const transcript = isUsableVoiceTranscript(descriptor.transcript)
                ? normalizeTranscript(descriptor.transcript) : previous.transcript;
            voices.set(key, { ...previous, ...descriptor, transcript, isDirect: true });
        }
        onAttempt?.({ attempt, pendingCount: pending().length });
    }

    return [...voices.values()].filter((voice) => isUsableVoiceTranscript(voice.transcript));
}

export function hasUntranscribedDirectVkVoice(rawMessage, resolvedTranscripts = [], directMessageText = '') {
    if (String(directMessageText ?? '').trim()) return false;
    const directVoices = collectVkVoiceAttachments(rawMessage).filter((voice) => voice.isDirect);
    if (!directVoices.length) return false;
    const resolvedKeys = new Set((Array.isArray(resolvedTranscripts) ? resolvedTranscripts : [])
        .filter((voice) => voice?.isDirect && isUsableVoiceTranscript(voice?.transcript))
        .map((voice) => String(voice.attachmentKey ?? '').trim())
        .filter(Boolean));
    return directVoices.some((voice) => (
        !isUsableVoiceTranscript(voice.transcript) && !resolvedKeys.has(String(voice.attachmentKey ?? '').trim())
    ));
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
        if (!isUsableVoiceTranscript(text) || seen.has(text)) continue;
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
    totalTimeoutMs = 180_000,
    signal = getCurrentOperationSignal(),
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
            capability: 'audio-transcription',
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

    // STT has a finite request budget of its own. Do not inherit the generic
    // unlimited recovery loop: a broken endpoint used to hold messages for 2h.
    const budgetSignal = AbortSignal.timeout(totalTimeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, budgetSignal]) : budgetSignal;
    const result = await executeRuntimeModelFailover({
        candidates,
        maxRounds: 1,
        failuresBeforeQuarantine: 3,
        signal: requestSignal,
        shouldAdvanceCandidate(error) {
            const code = Number(error?.status);
            if (error?.code === 'VOICE_TRANSCRIPT_INVALID') return true;
            if (error?.code === 'VOICE_TRANSCRIPTION_UPSTREAM_ERROR' && code === 200) return true;
            return [400, 401, 403, 404, 405, 415, 422].includes(code);
        },
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
                    requestSignal.throwIfAborted();
                    const startedAt = Date.now();
                    const form = new FormData();
                    form.append('model', model);
                    form.append('response_format', 'json');
                    form.append('language', 'ru');
                    form.append(
                        'file',
                        new Blob([buffer], { type: mimeType || 'application/octet-stream' }),
                        filename || 'voice.ogg',
                    );
                    const response = await fetchImpl(`${credential.baseUrl}/audio/transcriptions`, {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${credential.secret}` },
                        body: form,
                        signal: AbortSignal.any([requestSignal, AbortSignal.timeout(timeoutMs)]),
                    });
                    const bodyText = await response.text();
                    let payload = null;
                    try {
                        payload = JSON.parse(bodyText);
                    } catch {
                        payload = null;
                    }
                    const value = payload?.text ?? payload?.transcript ?? '';
                    const transcript = typeof value === 'string' ? normalizeTranscript(value) : '';
                    if (!response.ok || payload?.error) {
                        const detail = normalizeTranscript(
                            payload?.error?.message ?? payload?.message ?? bodyText,
                        ).slice(0, 500);
                        const failure = new Error(
                            `${credential.name} ${model}: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`,
                        );
                        failure.status = response.status;
                        if (payload?.error && !isTechnicalModelFailure(failure)) failure.code = 'VOICE_TRANSCRIPTION_UPSTREAM_ERROR';
                        throw failure;
                    }
                    if (!isUsableVoiceTranscript(transcript)) {
                        const failure = new Error(`${credential.name} ${model}: распознавание не вернуло полный текст речи.`);
                        failure.code = 'VOICE_TRANSCRIPT_INVALID';
                        throw failure;
                    }
                    return {
                        text: transcript,
                        model,
                        provider: credential.name,
                        transport: 'audio-transcriptions',
                        usage: payload?.usage,
                        durationMs: Date.now() - startedAt,
                    };
                } catch (error) {
                    lastError = error;
                    console.warn('[STT MODEL FAILURE]', {
                        provider: credential.name, model, error: formatPrivateError(error),
                    });
                    requestSignal.throwIfAborted();
                    const modelCompatibilityFailure = ['VOICE_TRANSCRIPTION_UPSTREAM_ERROR', 'VOICE_TRANSCRIPT_INVALID'].includes(error?.code)
                        || [400, 404, 405, 415, 422].includes(Number(error?.status))
                        || error?.code === 'VOICE_TRANSCRIPT_INVALID';
                    if (!modelCompatibilityFailure) throw error;
                }
            }

            throw lastError || new Error(`${credential.name}: ни одна STT-модель не сработала.`);
        },
        onEvent(event) {
            if (event.type === 'failure') {
                console.warn('[STT ATTEMPT FAILURE]', {
                    provider: event.credential?.name, attempt: event.attempt,
                    round: event.round, durationMs: event.durationMs,
                    retryable: event.retryable, error: formatPrivateError(event.error),
                });
            } else if (event.type === 'rotate') {
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
