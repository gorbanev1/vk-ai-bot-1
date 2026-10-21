import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const EVENT_INGEST_AUDIT_FILE = 'event-ingest-audit.jsonl';

function safeText(value, limit = 4000) {
    return String(value ?? '')
        .replace(/\u0000/gu, '')
        .slice(0, Math.max(0, Number(limit) || 0));
}

function cleanDetails(value, depth = 0) {
    if (depth > 5) return '[depth-limit]';
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') return safeText(value, 8000);
    if (Array.isArray(value)) return value.slice(0, 100).map((item) => cleanDetails(item, depth + 1));
    if (typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).slice(0, 100).map(([key, item]) => [
                safeText(key, 120),
                cleanDetails(item, depth + 1),
            ]),
        );
    }
    return safeText(value, 1000);
}

export function appendEventIngestAudit({
    dataDirectory = './data',
    sourceType = '',
    sourceKey = '',
    itemId = '',
    sourceUrl = '',
    status = '',
    reason = '',
    details = {},
    rawText = '',
    at = Math.floor(Date.now() / 1000),
} = {}) {
    try {
        const directory = String(dataDirectory || './data');
        mkdirSync(directory, { recursive: true });
        const row = {
            version: 1,
            at: Number(at) || Math.floor(Date.now() / 1000),
            sourceType: safeText(sourceType, 80),
            sourceKey: safeText(sourceKey, 240),
            itemId: safeText(itemId, 240),
            sourceUrl: safeText(sourceUrl, 1500),
            status: safeText(status, 120),
            reason: safeText(reason, 1000),
            details: cleanDetails(details),
            rawText: safeText(rawText, 6000),
        };
        appendFileSync(
            join(directory, EVENT_INGEST_AUDIT_FILE),
            `${JSON.stringify(row)}\n`,
            'utf8',
        );
        return row;
    } catch (error) {
        console.error('[EVENT INGEST AUDIT WRITE ERROR]', String(error?.message ?? error));
        return null;
    }
}
