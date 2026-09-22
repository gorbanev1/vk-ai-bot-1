/**
 * Deterministic pre-AI fingerprints for public source posts.
 * Text similarity is intentionally local and cheap. Image fingerprints contain
 * an exact SHA-256 plus a metadata-insensitive visual-payload SHA-256 for the
 * common JPEG/PNG/WebP formats, so duplicate posters can be rejected before
 * any vision request.
 */
import { createHash } from 'node:crypto';

import {
    EVENT_OPERATION_MAX_ATTEMPTS,
    runEventOperationWithRetries,
} from './eventRetry.js';

function sha256(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

export function normalizeSourcePostText(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/ё/gu, 'е')
        .replace(/https?:\/\/\S+/giu, ' <url> ')
        .replace(/[^a-zа-я0-9<>]+/giu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

export function createSourceTextFingerprint(value) {
    return sha256(Buffer.from(normalizeSourcePostText(value), 'utf8'));
}


export function isLikelyVkProfileAvatarUrl(value) {
    const url = String(value ?? '').trim();
    if (!url) return false;
    return /(?:[?&])ava=1(?:&|$)/iu.test(url) ||
        /(?:^|[/?&._-])avatar(?:[/?&._=-]|$)/iu.test(url);
}

/**
 * VK post DOM/API payloads often mix announcement photos with public avatars,
 * audio covers and tiny UI assets. Those resources are not announcement
 * posters and must never participate in poster vision/fingerprinting.
 */
export function isLikelyVkNonPosterUiImageUrl(value) {
    const url = String(value ?? '').trim();
    if (!url) return false;
    if (isLikelyVkProfileAvatarUrl(url)) return true;
    if (/(?:[?&])type=(?:audio|emoji|reaction|sticker|gift|icon)(?:&|$)/iu.test(url)) return true;
    if (/(?:^|[/?&._-])(?:emoji|reaction|sticker|favicon|badge|smile)(?:[/?&._=-]|$)/iu.test(url)) return true;

    // Reject an asset that advertises only tiny raster variants. Do not reject
    // a normal VK photo just because its `cs` preview is small when `as=` also
    // contains proper poster sizes.
    const sizes = [...url.matchAll(/(?:^|[?&,=])(?:size=|cs=)?(\d{1,4})x(\d{1,4})(?=$|[,&])/giu)]
        .map((match) => [Number(match[1]), Number(match[2])])
        .filter(([width, height]) => width > 0 && height > 0);
    if (sizes.length && Math.max(...sizes.map(([width, height]) => Math.max(width, height))) <= 160) {
        return true;
    }
    return false;
}

function ngramSet(value, size = 3) {
    const source = normalizeSourcePostText(value);
    if (!source) return new Set();
    if (source.length <= size) return new Set([source]);
    const result = new Set();
    for (let index = 0; index <= source.length - size; index += 1) {
        result.add(source.slice(index, index + size));
    }
    return result;
}

/** Sørensen-Dice over normalized character trigrams. */
export function sourceTextSimilarity(left, right) {
    const aText = normalizeSourcePostText(left);
    const bText = normalizeSourcePostText(right);
    if (!aText && !bText) return 1;
    if (!aText || !bText) return 0;
    if (aText === bText) return 1;

    const a = ngramSet(aText);
    const b = ngramSet(bText);
    if (!a.size || !b.size) return 0;
    let intersection = 0;
    const small = a.size <= b.size ? a : b;
    const large = a.size <= b.size ? b : a;
    for (const token of small) {
        if (large.has(token)) intersection += 1;
    }
    return (2 * intersection) / (a.size + b.size);
}

function stripJpegMetadata(buffer) {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
    const chunks = [buffer.subarray(0, 2)];
    let offset = 2;
    while (offset + 1 < buffer.length) {
        if (buffer[offset] !== 0xff) {
            chunks.push(buffer.subarray(offset));
            break;
        }
        let markerOffset = offset;
        while (markerOffset < buffer.length && buffer[markerOffset] === 0xff) markerOffset += 1;
        if (markerOffset >= buffer.length) break;
        const marker = buffer[markerOffset];
        const markerStart = offset;
        offset = markerOffset + 1;
        if (marker === 0xd9) {
            chunks.push(buffer.subarray(markerStart, offset));
            break;
        }
        if (marker === 0xda) {
            // SOS: the remaining entropy-coded payload is visual data. Keep all.
            chunks.push(buffer.subarray(markerStart));
            break;
        }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            chunks.push(buffer.subarray(markerStart, offset));
            continue;
        }
        if (offset + 1 >= buffer.length) break;
        const length = buffer.readUInt16BE(offset);
        if (length < 2 || offset + length > buffer.length) break;
        const segmentEnd = offset + length;
        const isMetadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
        if (!isMetadata) chunks.push(buffer.subarray(markerStart, segmentEnd));
        offset = segmentEnd;
    }
    return Buffer.concat(chunks);
}

function stripPngMetadata(buffer) {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (buffer.length < 12 || !buffer.subarray(0, 8).equals(signature)) return null;
    const chunks = [buffer.subarray(0, 8)];
    let offset = 8;
    const visualTypes = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS']);
    while (offset + 12 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const end = offset + 12 + length;
        if (end > buffer.length) break;
        const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
        if (visualTypes.has(type)) chunks.push(buffer.subarray(offset, end));
        offset = end;
        if (type === 'IEND') break;
    }
    return Buffer.concat(chunks);
}

function stripWebpMetadata(buffer) {
    if (
        buffer.length < 12 ||
        buffer.subarray(0, 4).toString('ascii') !== 'RIFF' ||
        buffer.subarray(8, 12).toString('ascii') !== 'WEBP'
    ) return null;
    const chunks = [Buffer.from('WEBP')];
    let offset = 12;
    const visualTypes = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF']);
    while (offset + 8 <= buffer.length) {
        const type = buffer.subarray(offset, offset + 4).toString('ascii');
        const length = buffer.readUInt32LE(offset + 4);
        const padded = length + (length % 2);
        const end = offset + 8 + padded;
        if (end > buffer.length) break;
        if (visualTypes.has(type)) chunks.push(buffer.subarray(offset, end));
        offset = end;
    }
    return Buffer.concat(chunks);
}

function visualPayload(buffer) {
    return stripJpegMetadata(buffer) || stripPngMetadata(buffer) || stripWebpMetadata(buffer) || buffer;
}

export function fingerprintImageBuffer(buffer, { url = '' } = {}) {
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    if (!bytes.length) return null;
    return {
        url: String(url ?? '').trim(),
        sha256: sha256(bytes),
        visualHash: sha256(visualPayload(bytes)),
        bytes: bytes.length,
    };
}

export function fingerprintImageUrlFallback(url, {
    error = '',
    attempts = EVENT_OPERATION_MAX_ATTEMPTS,
} = {}) {
    const cleanUrl = String(url ?? '').trim();
    if (!/^https?:\/\//iu.test(cleanUrl)) return null;
    const urlHash = sha256(Buffer.from(cleanUrl, 'utf8'));
    return {
        url: cleanUrl,
        sha256: `url-fallback:${urlHash}`,
        visualHash: `url-fallback:${urlHash}`,
        bytes: 0,
        degraded: true,
        fingerprintSource: 'url-fallback-v186',
        attempts: Math.max(1, Number(attempts) || EVENT_OPERATION_MAX_ATTEMPTS),
        error: String(error ?? '').slice(0, 1000),
    };
}

export function isRetryableRemoteFingerprintError(error) {
    const message = String(error?.message ?? error ?? '').toLowerCase();
    const httpMatch = message.match(/\bhttp\s+(\d{3})\b/u);
    if (httpMatch) {
        const status = Number(httpMatch[1]);
        return status === 408 || status === 425 || status === 429 || status >= 500;
    }
    return /timeout|timed out|fetch failed|network|econn|socket|aborted|temporar/u.test(message);
}

export async function fingerprintRemoteImages({
    imageUrls,
    fetchBuffer,
    maximum = 4,
    maxAttempts = EVENT_OPERATION_MAX_ATTEMPTS,
    retrySleepFn = undefined,
    onAttemptError = null,
    onRecovered = null,
    onFallback = null,
} = {}) {
    if (typeof fetchBuffer !== 'function') return [];
    const urls = [...new Set((Array.isArray(imageUrls) ? imageUrls : [])
        .map((value) => String(value ?? '').trim())
        .filter((value) => /^https?:\/\//iu.test(value))
        .filter((value) => !isLikelyVkNonPosterUiImageUrl(value)))]
        .slice(0, Math.max(1, Math.min(12, Number(maximum) || 4)));
    const results = [];
    for (const url of urls) {
        try {
            const response = await runEventOperationWithRetries(
                () => fetchBuffer(url),
                {
                    label: `image-fingerprint:${new URL(url).hostname}`,
                    maxAttempts,
                    sleepFn: retrySleepFn,
                    shouldRetry: isRetryableRemoteFingerprintError,
                    onAttemptError: async (details) => {
                        await onAttemptError?.({ ...details, url });
                    },
                    onRecovered: async (details) => {
                        await onRecovered?.({ ...details, url });
                    },
                },
            );
            const fingerprint = fingerprintImageBuffer(response?.buffer ?? response, { url });
            if (fingerprint) results.push(fingerprint);
        } catch (error) {
            const attempts = Number(error?.eventRetryAttempts ?? maxAttempts) || EVENT_OPERATION_MAX_ATTEMPTS;
            console.warn(
                '[EVENT IMAGE FINGERPRINT ERROR]',
                url,
                `attempts=${attempts}`,
                String(error?.message ?? error),
            );
            // Fingerprint is a pre-AI dedupe optimization. A remote CDN failure
            // must not suppress poster vision or the event itself.
            const fallback = fingerprintImageUrlFallback(url, {
                error: String(error?.message ?? error),
                attempts,
            });
            if (fallback) {
                results.push(fallback);
                await onFallback?.({
                    url,
                    attempts,
                    error,
                    fingerprint: fallback,
                });
            }
        }
    }
    return results;
}

export function parseImageFingerprints(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    try {
        const parsed = JSON.parse(String(value ?? '[]'));
        return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    } catch {
        return [];
    }
}

function containsUnreliableImageFingerprint(items) {
    return (Array.isArray(items) ? items : []).some((item) => (
        !item || item.degraded === true ||
        String(item.fingerprintSource || '').startsWith('url-fallback') ||
        String(item.visualHash || '').startsWith('url-fallback:') ||
        String(item.sha256 || '').startsWith('url-fallback:')
    ));
}

export function imageFingerprintSetsReusable(left, right) {
    // A failed CDN fetch is not evidence that the picture stayed unchanged.
    if (containsUnreliableImageFingerprint(left) || containsUnreliableImageFingerprint(right)) return false;
    const normalize = (items) => (Array.isArray(items) ? items : [])
        .map((item) => String(item?.visualHash || item?.sha256 || '').trim())
        .filter(Boolean)
        .sort();
    const a = normalize(left);
    const b = normalize(right);

    // Reuse is only safe when both runs have an actual fingerprint set.
    // Empty/unknown media must not suppress a future vision attempt.
    if (!a.length || !b.length || a.length !== b.length) return false;
    return a.every((value, index) => value === b[index]);
}

export function imageFingerprintSetsEqual(left, right) {
    // Marking two URL fallbacks as equal would suppress re-fetch and poster Vision.
    if (containsUnreliableImageFingerprint(left) || containsUnreliableImageFingerprint(right)) return false;
    const normalize = (items) => (Array.isArray(items) ? items : [])
        .map((item) => String(item?.visualHash || item?.sha256 || '').trim())
        .filter(Boolean)
        .sort();
    const a = normalize(left);
    const b = normalize(right);
    if (!a.length && !b.length) return true;
    if (a.length !== b.length) return false;
    return a.every((value, index) => value === b[index]);
}
