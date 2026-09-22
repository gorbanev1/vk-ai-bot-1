/**
 * Durable per-run diagnostics for manual event/proposal parsing.
 *
 * The trace is intentionally verbose: every important parser branch may write
 * its input/output here. Secrets are redacted before touching disk so a trace
 * can be safely attached to a bug report.
 */
import {
    appendFileSync,
    mkdirSync,
    readdirSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const TRACE_DIRECTORY = 'event-parser';
const MAX_TRACE_FILES = 80;
const MAX_STRING_CHARS = 2_000_000;
const SECRET_KEY_RE = /(?:access[_-]?token|webtoken|authorization|api[_-]?key|secret|password|passwd|cookie|session|bearer|client[_-]?secret)/iu;
const URL_SECRET_PARAM_RE = /([?&](?:access_token|token|api_key|apikey|key|secret|password|auth|authorization|hash|lrt|sig|signature)=)[^&#\s]+/giu;

function sanitizeString(value) {
    const source = String(value ?? '');
    const redacted = source
        .replace(/\b(?:Bearer\s+)[A-Za-z0-9._~+\-/=]+/giu, 'Bearer [REDACTED]')
        .replace(URL_SECRET_PARAM_RE, '$1[REDACTED]')
        .replace(/("?(?:access_token|webToken|api_key|apikey|secret|password)"?\s*[:=]\s*["'])[^"']+(["'])/giu, '$1[REDACTED]$2');
    if (redacted.length <= MAX_STRING_CHARS) return redacted;
    return `${redacted.slice(0, MAX_STRING_CHARS)}\n...[TRACE STRING TRUNCATED ${redacted.length - MAX_STRING_CHARS} chars]`;
}

export function sanitizeEventParserTraceValue(value, {
    depth = 0,
    seen = new WeakSet(),
} = {}) {
    if (value == null) return value;
    if (typeof value === 'string') return sanitizeString(value);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
    if (value instanceof Error) {
        return {
            name: sanitizeString(value.name),
            message: sanitizeString(value.message),
            stack: sanitizeString(value.stack || ''),
            code: sanitizeString(value.code || ''),
        };
    }
    if (typeof value !== 'object') return sanitizeString(value);
    if (depth >= 12) return '[TRACE MAX DEPTH]';
    if (seen.has(value)) return '[TRACE CIRCULAR]';
    seen.add(value);

    if (Array.isArray(value)) {
        return value.slice(0, 500).map((item) => sanitizeEventParserTraceValue(item, {
            depth: depth + 1,
            seen,
        }));
    }

    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 800)) {
        if (SECRET_KEY_RE.test(key)) {
            output[key] = '[REDACTED]';
            continue;
        }
        output[key] = sanitizeEventParserTraceValue(item, {
            depth: depth + 1,
            seen,
        });
    }
    return output;
}

function pruneTraceFiles(directory) {
    try {
        const files = readdirSync(directory)
            .filter((name) => name.endsWith('.jsonl') && name !== 'latest.jsonl')
            .map((name) => ({
                name,
                mtimeMs: statSync(join(directory, name)).mtimeMs,
            }))
            .sort((left, right) => right.mtimeMs - left.mtimeMs);
        for (const file of files.slice(MAX_TRACE_FILES)) {
            unlinkSync(join(directory, file.name));
        }
    } catch {
        // Diagnostics must never break the parser itself.
    }
}

export function createEventParserTrace({
    dataDirectory = './data',
    label = 'proposal',
} = {}) {
    const directory = resolve(dataDirectory, 'logs', TRACE_DIRECTORY);
    mkdirSync(directory, { recursive: true });
    pruneTraceFiles(directory);

    const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
    const suffix = randomBytes(3).toString('hex');
    const safeLabel = String(label || 'proposal').replace(/[^a-z0-9_-]+/giu, '-').slice(0, 40) || 'proposal';
    const fileName = `${timestamp}_${safeLabel}_${suffix}.jsonl`;
    const filePath = join(directory, fileName);
    const latestPath = join(directory, 'latest.jsonl');
    const relativePath = `data/logs/${TRACE_DIRECTORY}/${fileName}`;
    let sequence = 0;

    const writeRecord = (stage, data = null) => {
        const record = {
            ts: new Date().toISOString(),
            seq: ++sequence,
            stage: String(stage || 'unknown'),
            data: sanitizeEventParserTraceValue(data),
        };
        const line = `${JSON.stringify(record)}\n`;
        try {
            appendFileSync(filePath, line, 'utf8');
            appendFileSync(latestPath, line, 'utf8');
        } catch (error) {
            console.warn('[EVENT PARSER TRACE WRITE ERROR]', sanitizeString(error?.message || error));
        }
        return record;
    };

    // latest.jsonl always mirrors only the current run.
    writeFileSync(latestPath, '', 'utf8');
    writeFileSync(filePath, '', 'utf8');
    writeRecord('trace.start', {
        filePath,
        relativePath,
        pid: process.pid,
        node: process.version,
    });
    console.log('[EVENT PARSER TRACE]', `file=${filePath}`);

    return {
        filePath,
        relativePath,
        latestPath,
        log: writeRecord,
        finish(data = null) {
            return writeRecord('trace.finish', data);
        },
    };
}
