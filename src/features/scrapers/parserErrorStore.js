import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';

const STORE_DIRECTORY = 'parser-error-archives';
const INDEX_FILE = 'errors.json';

function safeJson(value) {
    return JSON.stringify(value, (key, item) => {
        if (/token|cookie|authorization|password|secret|api[_-]?key/iu.test(String(key))) return '[REDACTED]';
        if (item instanceof Error) return { name: item.name, message: item.message, code: item.code, stack: item.stack };
        if (typeof item === 'bigint') return String(item);
        return item;
    });
}

function storePaths(dataDirectory) {
    const directory = resolve(dataDirectory, STORE_DIRECTORY);
    return { directory, indexPath: join(directory, INDEX_FILE) };
}

function readIndex(indexPath) {
    try {
        const value = JSON.parse(readFileSync(indexPath, 'utf8'));
        return Array.isArray(value?.errors) ? value : { version: 1, errors: [] };
    } catch { return { version: 1, errors: [] }; }
}

function writeIndex(indexPath, payload) {
    const temporary = `${indexPath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(temporary, indexPath);
}

function safeArchiveName(value) {
    return String(value || 'run').replace(/[^a-z0-9._-]+/giu, '-').slice(0, 180) || 'run';
}

export function archiveParserErrorRun({ dataDirectory = './data', runDirectory = '', runId = '', extra = null } = {}) {
    if (!runDirectory || !existsSync(resolve(runDirectory))) return '';
    const { directory } = storePaths(resolve(dataDirectory));
    mkdirSync(directory, { recursive: true });
    const id = safeArchiveName(runId || basename(resolve(runDirectory)));
    const archiveDirectory = join(directory, id);
    // The run is written incrementally.  Copy once when the first error is
    // recorded; `refreshParserErrorEvidence` replaces this snapshot after the
    // run finishes, avoiding concurrent recursive copies when several source
    // workers fail together.
    if (!existsSync(archiveDirectory)) cpSync(resolve(runDirectory), archiveDirectory, { recursive: true, force: true, errorOnExist: false });
    if (extra) writeFileSync(join(archiveDirectory, 'error-run.json'), `${JSON.stringify({ runId: id, archivedAt: new Date().toISOString(), ...extra }, null, 2)}\n`, 'utf8');
    return archiveDirectory;
}

/** Keep a complete immutable run beside an indexed item failure. This includes the original DOM, cache, media, parser output and trace. */
export function recordParserError({
    dataDirectory = './data', runDirectory = '', runId = '', tracePath = '', sourceId = '', sourceLabel = '',
    sourceKind = '', partyPool = 'primary', itemId = '', item = null, sourceUrl = '', stage = 'processing',
    error = '', contentHash = '', status = 'open', attempts = 1, details = null,
} = {}) {
    const root = resolve(dataDirectory);
    const { directory, indexPath } = storePaths(root);
    mkdirSync(directory, { recursive: true });
    const sourceRunDirectory = runDirectory ? resolve(runDirectory) : '';
    const normalizedRunId = safeArchiveName(runId || basename(sourceRunDirectory) || `run-${Date.now()}`);
    const archiveDirectory = join(directory, normalizedRunId);
    if (sourceRunDirectory && existsSync(sourceRunDirectory) && !existsSync(archiveDirectory)) {
        archiveParserErrorRun({ dataDirectory: root, runDirectory: sourceRunDirectory, runId: normalizedRunId });
    }
    const normalizedItemId = String(itemId || '');
    const identity = `${sourceId}\u0000${normalizedItemId}\u0000${contentHash || ''}\u0000${stage}`;
    const id = createHash('sha256').update(identity).digest('hex').slice(0, 24);
    const payload = readIndex(indexPath);
    const now = new Date().toISOString();
    const relativeToRun = (candidate) => {
        if (!candidate || !sourceRunDirectory) return '';
        const absolute = resolve(candidate);
        const rel = relative(sourceRunDirectory, absolute);
        if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) return '';
        return rel;
    };
    const archivedTraceRelative = relativeToRun(tracePath);
    const existingIndex = payload.errors.findIndex((row) => row.id === id);
    const previous = existingIndex >= 0 ? payload.errors[existingIndex] : null;
    const evidenceHistory = Array.isArray(previous?.evidenceHistory) ? [...previous.evidenceHistory] : [];
    if (previous?.archiveDirectory && previous.lastRunId && previous.lastRunId !== normalizedRunId) {
        const lastEvidence = evidenceHistory.at(-1);
        if (lastEvidence?.runId !== previous.lastRunId) {
            evidenceHistory.push({
                runId: previous.lastRunId,
                archiveDirectory: previous.archiveDirectory,
                tracePath: previous.tracePath || '',
                rawCachePath: previous.rawCachePath || '',
                domPath: previous.domPath || '',
                capturedAt: previous.lastSeenAt || now,
            });
        }
    }
    const record = {
        ...(previous || {}), id, sourceId: String(sourceId || ''), sourceLabel: String(sourceLabel || sourceId || ''),
        sourceKind: String(sourceKind || ''), partyPool: String(partyPool || 'primary'), itemId: normalizedItemId,
        sourceUrl: String(sourceUrl || ''), stage: String(stage || 'processing'), status: String(status || 'open'),
        contentHash: String(contentHash || ''), error: typeof error === 'string' ? error : safeJson(error),
        attempts: Math.max(1, Number(previous?.attempts || 0) + (previous ? 1 : 0), Number(attempts) || 1),
        firstSeenAt: previous?.firstSeenAt || now, lastSeenAt: now, lastRunId: normalizedRunId,
        originalRunId: previous?.originalRunId || normalizedRunId,
        originalArchiveDirectory: previous?.originalArchiveDirectory || previous?.archiveDirectory || (existsSync(archiveDirectory) ? archiveDirectory : ''),
        evidenceHistory,
        archiveDirectory: existsSync(archiveDirectory) ? archiveDirectory : '',
        tracePath: archivedTraceRelative ? join(archiveDirectory, archivedTraceRelative) : '',
        rawCachePath: relativeToRun(details?.rawCachePath) ? join(archiveDirectory, relativeToRun(details.rawCachePath)) : '',
        domPath: relativeToRun(details?.domPath) ? join(archiveDirectory, relativeToRun(details.domPath)) : '',
        item: item && typeof item === 'object' ? item : (previous?.item || null),
        details: { ...(previous?.details || {}), ...(details && typeof details === 'object' ? details : {}) },
        replayAttempts: Array.isArray(previous?.replayAttempts) ? previous.replayAttempts : [],
    };
    if (existingIndex >= 0) payload.errors[existingIndex] = record;
    else payload.errors.push(record);
    payload.version = 1;
    payload.updatedAt = now;
    writeIndex(indexPath, payload);
    return record;
}

/** Refresh the durable evidence copy after the source run has finished writing its trace. */
export function refreshParserErrorEvidence({ dataDirectory = './data', runDirectory = '', runId = '' } = {}) {
    const sourceRunDirectory = resolve(runDirectory || '');
    if (!runDirectory || !existsSync(sourceRunDirectory)) return 0;
    const id = safeArchiveName(runId || basename(sourceRunDirectory));
    const archiveDirectory = join(storePaths(resolve(dataDirectory)).directory, id);
    if (existsSync(archiveDirectory)) rmSync(archiveDirectory, { recursive: true, force: true });
    cpSync(sourceRunDirectory, archiveDirectory, { recursive: true, force: true, errorOnExist: false });
    const errors = listParserErrors({ dataDirectory, includeResolved: true }).filter((row) => row.lastRunId === id);
    for (const row of errors) {
        const update = { archiveDirectory };
        if (row.details?.traceRelativePath) update.tracePath = join(archiveDirectory, row.details.traceRelativePath);
        if (row.details?.rawCacheRelativePath) update.rawCachePath = join(archiveDirectory, row.details.rawCacheRelativePath);
        if (row.details?.domRelativePath) update.domPath = join(archiveDirectory, row.details.domRelativePath);
        updateParserError(dataDirectory, row.id, update);
    }
    return errors.length;
}

export function listParserErrors({ dataDirectory = './data', includeResolved = false } = {}) {
    const { indexPath } = storePaths(resolve(dataDirectory));
    const errors = readIndex(indexPath).errors;
    return includeResolved ? errors : errors.filter((row) => !['resolved', 'classified', 'ignored'].includes(String(row.status || 'open')));
}

export function updateParserError(dataDirectory, id, update = {}) {
    const { directory, indexPath } = storePaths(resolve(dataDirectory));
    mkdirSync(directory, { recursive: true });
    const payload = readIndex(indexPath);
    const index = payload.errors.findIndex((row) => String(row.id) === String(id));
    if (index < 0) return null;
    const previous = payload.errors[index];
    const replay = update.replayAttempt && typeof update.replayAttempt === 'object' ? update.replayAttempt : null;
    payload.errors[index] = {
        ...previous, ...update,
        replayAttempts: replay ? [...(previous.replayAttempts || []), replay] : (previous.replayAttempts || []),
        updatedAt: new Date().toISOString(),
    };
    delete payload.errors[index].replayAttempt;
    payload.updatedAt = new Date().toISOString();
    writeIndex(indexPath, payload);
    return payload.errors[index];
}

