import {
    appendFileSync,
    mkdirSync,
    writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

export const MEDIA_AUDIT_ROOT = resolve('data/audit/media');

function redactString(value) {
    return String(value ?? '')
        .replace(/(\/file\/bot)[^/]+\//giu, '$1[redacted]/')
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]')
        .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, 'sk-[redacted]')
        .replace(/\bnvapi-[A-Za-z0-9_-]{12,}\b/gu, 'nvapi-[redacted]')
        .replace(/((?:api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token|authorization)\s*[=:]\s*)[^\s,;]+/giu, '$1[redacted]');
}

function jsonSafe(value, depth = 0, seen = new WeakSet()) {
    if (value == null) return value;
    if (depth > 12) return '[max-depth]';
    if (typeof value === 'string') return redactString(value).slice(0, 30_000);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return String(value);
    if (typeof value !== 'object') return redactString(value).slice(0, 4000);
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 500).map((item) => jsonSafe(item, depth + 1, seen));
    const output = {};
    for (const [key, child] of Object.entries(value).slice(0, 600)) {
        if (/^(?:secret|api[_-]?key|authorization|cookie|cookies|password|credentials?|access[_-]?token|refresh[_-]?token|bearer)$/iu.test(key)) {
            output[key] = '[redacted]';
        } else {
            output[key] = jsonSafe(child, depth + 1, seen);
        }
    }
    return output;
}

function ensureSessionDirectory(session) {
    if (!session?.directory) return '';
    mkdirSync(session.directory, { recursive: true });
    return session.directory;
}

export function createMediaAuditSession({
    operationId,
    botVersion,
    platform,
    chatId,
    messageId,
    rawMessage,
    mediaContext,
}) {
    const safeOperationId = String(operationId || `unscoped-${Date.now()}`)
        .replace(/[^a-zA-Z0-9._-]+/gu, '_')
        .slice(0, 160);
    const session = {
        operationId: safeOperationId,
        botVersion: String(botVersion || ''),
        platform: String(platform || ''),
        chatId: Number(chatId || 0),
        messageId: Number(messageId || 0),
        directory: join(MEDIA_AUDIT_ROOT, safeOperationId),
        createdAt: new Date().toISOString(),
    };
    ensureSessionDirectory(session);
    writeFileSync(join(session.directory, 'metadata.json'), `${JSON.stringify(jsonSafe({
        botVersion: session.botVersion,
        operationId: session.operationId,
        platform: session.platform,
        chatId: session.chatId,
        messageId: session.messageId,
        createdAt: session.createdAt,
        mediaContext: mediaContext ? {
            stats: mediaContext.stats,
            limits: mediaContext.limits,
            images: mediaContext.images?.map((image) => ({
                order: image.order,
                sourcePath: image.sourcePath,
                nestingDepth: image.nestingDepth,
                sourceMessageId: image.sourceMessageId,
                attachmentId: image.attachmentId,
                attachmentType: image.attachmentType,
                attachmentIndex: image.attachmentIndex,
                attachmentCount: image.attachmentCount,
                imageIndexInGroup: image.imageIndexInGroup,
                imageCountInGroup: image.imageCountInGroup,
                url: image.url,
                canonicalUrl: image.canonicalUrl,
                caption: image.caption,
            })),
        } : null,
    }), null, 2)}\n`, 'utf8');
    writeFileSync(join(session.directory, 'message-structure.json'), `${JSON.stringify(jsonSafe(rawMessage), null, 2)}\n`, 'utf8');
    return session;
}

export function appendMediaAuditEvent(session, event) {
    if (!session?.directory) return;
    try {
        ensureSessionDirectory(session);
        appendFileSync(
            join(session.directory, 'pipeline.jsonl'),
            `${JSON.stringify(jsonSafe({ ts: new Date().toISOString(), ...event }))}\n`,
            'utf8',
        );
    } catch {
        // Forensic logging must never break user handling.
    }
}

export function appendMediaAuditError(session, event) {
    if (!session?.directory) return;
    try {
        ensureSessionDirectory(session);
        appendFileSync(
            join(session.directory, 'errors.jsonl'),
            `${JSON.stringify(jsonSafe({ ts: new Date().toISOString(), ...event }))}\n`,
            'utf8',
        );
    } catch {
        // Forensic logging must never break user handling.
    }
}

export function saveMediaAuditImage(session, image, buffer, mimeType = '') {
    if (!session?.directory || !Buffer.isBuffer(buffer) || !buffer.length) return '';
    try {
        ensureSessionDirectory(session);
        const extension = mimeType === 'image/png'
            ? 'png'
            : mimeType === 'image/webp'
                ? 'webp'
                : mimeType === 'image/gif'
                    ? 'gif'
                    : 'jpg';
        const order = String(Number(image?.order || 0)).padStart(3, '0');
        const hash = String(image?.sha256 || '').slice(0, 16) || 'nohash';
        const path = join(session.directory, `${order}-${hash}.${extension}`);
        writeFileSync(path, buffer);
        return path;
    } catch {
        return '';
    }
}

export function writeMediaAuditResults(session, results) {
    if (!session?.directory) return;
    try {
        ensureSessionDirectory(session);
        const rows = Array.isArray(results) ? results : [];
        const ocr = rows.map((row) => [
            `IMAGE ${row.order}`,
            `sourcePath: ${row.sourcePath || ''}`,
            row.ocrText || '',
        ].filter(Boolean).join('\n')).join('\n\n');
        const vision = rows.map((row) => [
            `IMAGE ${row.order}`,
            `sourcePath: ${row.sourcePath || ''}`,
            `contentType: ${row.contentType || ''}`,
            row.visualDescription || '',
        ].filter(Boolean).join('\n')).join('\n\n');
        writeFileSync(join(session.directory, 'ocr.txt'), `${redactString(ocr)}\n`, 'utf8');
        writeFileSync(join(session.directory, 'vision.txt'), `${redactString(vision)}\n`, 'utf8');
        writeFileSync(join(session.directory, 'results.json'), `${JSON.stringify(jsonSafe(rows), null, 2)}\n`, 'utf8');
    } catch {
        // Forensic logging must never break user handling.
    }
}
