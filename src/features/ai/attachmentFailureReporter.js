import {
    appendFileSync,
    mkdirSync,
    readFileSync,
} from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export const ATTACHMENT_FAILURE_REPORT_DELAY_MS = 3 * 60 * 60 * 1000;
export const ATTACHMENT_FAILURE_REPORT_RETRY_MS = 15 * 60 * 1000;
export const ATTACHMENT_FAILURE_REPORT_DIRECTORY = resolve('data/logs/attachment-failures');
export const ATTACHMENT_FAILURE_REPORT_JOURNAL = resolve(
    ATTACHMENT_FAILURE_REPORT_DIRECTORY,
    'pending.jsonl',
);

function ensureParent(path) {
    mkdirSync(dirname(path), { recursive: true });
}

function safeText(value, max = 4000) {
    return String(value ?? '')
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]')
        .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, 'sk-[redacted]')
        .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/gu, '[telegram-token-redacted]')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, max);
}

function jsonSafe(value, depth = 0) {
    if (value == null) return value;
    if (Buffer.isBuffer(value)) return `[buffer omitted: ${value.length} bytes]`;
    if (value instanceof Uint8Array) return `[binary omitted: ${value.byteLength} bytes]`;
    if (depth > 5) return '[max-depth]';
    if (typeof value === 'string') return safeText(value, 8000);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, 50).map((item) => jsonSafe(item, depth + 1));
    if (typeof value !== 'object') return safeText(value, 2000);
    const output = {};
    for (const [key, child] of Object.entries(value).slice(0, 100)) {
        if (/^(?:secret|api[_-]?key|authorization|cookie|cookies|password|credentials?|access[_-]?token|refresh[_-]?token|bearer)$/iu.test(key)) {
            output[key] = '[redacted]';
            continue;
        }
        output[key] = jsonSafe(child, depth + 1);
    }
    return output;
}

function appendJournal(row) {
    try {
        ensureParent(ATTACHMENT_FAILURE_REPORT_JOURNAL);
        appendFileSync(
            ATTACHMENT_FAILURE_REPORT_JOURNAL,
            `${JSON.stringify({ ts: new Date().toISOString(), ...jsonSafe(row) })}\n`,
            'utf8',
        );
        return true;
    } catch {
        return false;
    }
}

function readJournalRows() {
    let text = '';
    try {
        text = readFileSync(ATTACHMENT_FAILURE_REPORT_JOURNAL, 'utf8');
    } catch {
        return [];
    }
    const rows = [];
    for (const line of text.split(/\r?\n/u)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object') rows.push(parsed);
        } catch {
            // A damaged diagnostic line must not stop the queue from being read.
        }
    }
    return rows;
}

function buildState(rows) {
    const reports = new Map();
    for (const row of rows) {
        const reportId = safeText(row?.reportId, 200);
        if (!reportId) continue;
        const current = reports.get(reportId) || {};
        if (row.type === 'scheduled') {
            reports.set(reportId, {
                ...current,
                ...row,
                reportId,
                status: 'scheduled',
                nextAttemptAtMs: Number(row.dueAtMs || 0),
            });
            continue;
        }
        if (!reports.has(reportId)) continue;
        if (row.type === 'logged') {
            Object.assign(current, {
                logPath: safeText(row.logPath, 2000),
                logAbsolutePath: safeText(row.logAbsolutePath, 4000),
                loggedAt: safeText(row.ts, 100),
            });
        } else if (row.type === 'delivery-failed') {
            Object.assign(current, {
                lastDeliveryError: safeText(row.error, 4000),
                nextAttemptAtMs: Number(row.retryAtMs || 0),
            });
        } else if (row.type === 'delivered') {
            Object.assign(current, {
                status: 'delivered',
                deliveredAt: safeText(row.ts, 100),
                nextAttemptAtMs: Number.POSITIVE_INFINITY,
            });
        }
        reports.set(reportId, current);
    }
    return reports;
}

export function scheduleAttachmentFailureReport(payload, {
    nowMs = Date.now(),
    delayMs = ATTACHMENT_FAILURE_REPORT_DELAY_MS,
} = {}) {
    const reportId = safeText(payload?.reportId, 200) || `attach-${randomUUID()}`;
    const createdAtMs = Math.max(0, Number(nowMs) || Date.now());
    const dueAtMs = createdAtMs + Math.max(1_000, Number(delayMs) || ATTACHMENT_FAILURE_REPORT_DELAY_MS);
    const row = {
        type: 'scheduled',
        reportId,
        createdAtMs,
        dueAtMs,
        payload: jsonSafe(payload || {}),
    };
    if (!appendJournal(row)) {
        const error = new Error('ATTACHMENT_FAILURE_REPORT_QUEUE_WRITE_FAILED');
        error.code = 'ATTACHMENT_FAILURE_REPORT_QUEUE_WRITE_FAILED';
        throw error;
    }
    return row;
}

export function getDueAttachmentFailureReports({ nowMs = Date.now(), limit = 25 } = {}) {
    const state = buildState(readJournalRows());
    return [...state.values()]
        .filter((item) => item.status !== 'delivered')
        .filter((item) => Number(item.nextAttemptAtMs || item.dueAtMs || 0) <= Number(nowMs))
        .sort((left, right) => Number(left.dueAtMs || 0) - Number(right.dueAtMs || 0))
        .slice(0, Math.max(1, Number(limit) || 25));
}

function reportDayKey(nowMs = Date.now()) {
    return new Date(nowMs).toISOString().slice(0, 10);
}

export function writeAttachmentFailureReportLog(report, { nowMs = Date.now() } = {}) {
    const day = reportDayKey(nowMs);
    const relativePath = `data/logs/attachment-failures/${day}.jsonl`;
    const absolutePath = resolve(relativePath);
    const row = {
        ts: new Date(nowMs).toISOString(),
        type: 'attachment.failure.delayed-report',
        reportId: safeText(report?.reportId, 200),
        createdAtMs: Number(report?.createdAtMs || 0),
        dueAtMs: Number(report?.dueAtMs || 0),
        delayedMs: Math.max(0, Number(nowMs) - Number(report?.createdAtMs || nowMs)),
        payload: jsonSafe(report?.payload || {}),
    };
    ensureParent(absolutePath);
    appendFileSync(absolutePath, `${JSON.stringify(row)}\n`, 'utf8');
    appendJournal({
        type: 'logged',
        reportId: report?.reportId,
        logPath: relativePath.replaceAll('\\', '/'),
        logAbsolutePath: absolutePath,
    });
    return {
        relativePath: relativePath.replaceAll(sep, '/'),
        absolutePath,
    };
}

export function markAttachmentFailureReportDelivered(reportId) {
    return appendJournal({ type: 'delivered', reportId });
}

export function markAttachmentFailureReportDeliveryFailed(reportId, error, {
    nowMs = Date.now(),
    retryMs = ATTACHMENT_FAILURE_REPORT_RETRY_MS,
} = {}) {
    return appendJournal({
        type: 'delivery-failed',
        reportId,
        error: safeText(error?.message || error, 4000),
        retryAtMs: Number(nowMs) + Math.max(60_000, Number(retryMs) || ATTACHMENT_FAILURE_REPORT_RETRY_MS),
    });
}

export function buildAttachmentFailureOwnerMessage(report, logInfo) {
    const payload = report?.payload || {};
    const total = Math.max(0, Number(payload.total || 0));
    const processed = Math.max(0, Number(payload.processed || 0));
    const failed = Math.max(0, Number(payload.failed || (total - processed)));
    const reason = safeText(payload.error || payload.failureSummary || '', 1200);
    const lines = [
        '⚠️ Отчёт об ошибке обработки вложений',
        'Ошибка была зарегистрирована 3 часа назад; мгновенное уведомление в чат отключено.',
        `ID отчёта: ${safeText(report?.reportId, 200) || 'неизвестен'}`,
        payload.requestId ? `requestId: ${safeText(payload.requestId, 200)}` : '',
        payload.operationId ? `operationId: ${safeText(payload.operationId, 200)}` : '',
        payload.platform ? `Платформа: ${safeText(payload.platform, 80)}` : '',
        payload.peerId ? `peerId/chatId: ${safeText(payload.peerId, 120)}` : '',
        payload.messageId ? `messageId: ${safeText(payload.messageId, 120)}` : '',
        `Результат: обработано ${processed}/${total || processed + failed}; ошибок ${failed}.`,
        reason ? `Причина: ${reason}` : '',
        `Лог: ${safeText(logInfo?.relativePath, 2000)}`,
        `Полный путь к логу: ${safeText(logInfo?.absolutePath, 4000)}`,
    ];
    return lines.filter(Boolean).join('\n');
}
