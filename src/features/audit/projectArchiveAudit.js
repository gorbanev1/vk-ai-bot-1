import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;

const DEFAULT_LIMITS = Object.freeze({
    maxArchiveBytes: 50 * 1024 * 1024,
    maxEntries: 4_000,
    maxEntryBytes: 12 * 1024 * 1024,
    maxInflatedBytes: 120 * 1024 * 1024,
    maxSelectedFiles: 900,
    maxSelectedChars: 5_500_000,

    // V188.106: Project-audit requests intentionally stay much smaller than the
    // model context window. The production proxy observed in V188.104 cuts a
    // quiet origin response after ~120 seconds (HTTP 524). Huge 500k+ character
    // batches let Astra max spend several minutes in reasoning before enough
    // SSE data reaches that proxy. Smaller chunks/batches trade a few more
    // requests for substantially better retryability and fault isolation.
    maxChunkChars: 48_000,
    chunkOverlapChars: 1_500,
    maxBatchChars: 96_000,
    maxBatchChunks: 6,
});

const SENSITIVE_SEGMENTS = new Set([
    'node_modules',
    'data',
    'backup',
    'backups',
    '.git',
    'dist',
    'build',
    'coverage',
    '.idea',
    '.vscode',
    'browser-profiles',
    'browser_profiles',
    'cookies',
    'logs',
    'tmp',
    'temp',
    '.cache',
    'cache',
]);

const ALLOWED_TEXT_EXTENSIONS = new Set([
    '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
    '.json', '.jsonc', '.md', '.txt', '.yaml', '.yml',
    '.sql', '.html', '.htm', '.css', '.scss', '.less',
    '.xml', '.toml', '.ini', '.conf', '.cfg', '.properties',
    '.sh', '.bash', '.bat', '.cmd', '.ps1', '.py', '.rb',
    '.go', '.rs', '.java', '.kt', '.gradle', '.graphql', '.gql',
]);

const ALLOWED_TEXT_BASENAMES = new Set([
    'dockerfile',
    'makefile',
    'license',
    'readme',
    '.gitignore',
    '.dockerignore',
]);

const SENSITIVE_BASENAME_PATTERNS = [
    /^\.env(?:\..*)?$/iu,
    /^\.npmrc$/iu,
    /^\.yarnrc(?:\..*)?$/iu,
    /^credentials?(?:\..*)?$/iu,
    /^secrets?(?:\..*)?$/iu,
    /(?:^|[-_.])token(?:[-_.]|$)/iu,
];

const SENSITIVE_EXTENSIONS = new Set([
    '.db', '.sqlite', '.sqlite3', '.pem', '.key', '.p12', '.pfx', '.kdbx',
]);

function sha256(bufferOrText) {
    return createHash('sha256').update(bufferOrText).digest('hex');
}

function extensionOf(path) {
    const base = String(path ?? '').split('/').at(-1) || '';
    const index = base.lastIndexOf('.');
    return index > 0 ? base.slice(index).toLowerCase() : '';
}

function sanitizeArchivePath(value) {
    const raw = String(value ?? '').replaceAll('\\', '/').replace(/^\.\//u, '');
    if (!raw || raw.includes('\0')) throw new Error('ZIP contains an empty or NUL path.');
    if (raw.startsWith('/') || /^[a-z]:\//iu.test(raw)) {
        throw new Error(`ZIP contains an absolute path: ${raw.slice(0, 180)}`);
    }
    const parts = raw.split('/').filter((part) => part !== '');
    if (!parts.length) throw new Error('ZIP contains an invalid path.');
    if (parts.some((part) => part === '.' || part === '..')) {
        throw new Error(`ZIP path traversal rejected: ${raw.slice(0, 180)}`);
    }
    if (parts.length > 48) throw new Error(`ZIP path is too deep: ${raw.slice(0, 180)}`);
    return raw.endsWith('/') ? `${parts.join('/')}/` : parts.join('/');
}

function findEocd(buffer) {
    const minOffset = Math.max(0, buffer.length - (0xffff + 22));
    for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
        if (buffer.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) return offset;
    }
    return -1;
}

function readZipEntryData(archiveBuffer, entry, limits = DEFAULT_LIMITS) {
    if (entry.isDirectory) return Buffer.alloc(0);
    const offset = entry.localHeaderOffset;
    if (offset < 0 || offset + 30 > archiveBuffer.length) {
        throw new Error(`ZIP local header is outside archive: ${entry.path}`);
    }
    if (archiveBuffer.readUInt32LE(offset) !== ZIP_LOCAL_SIGNATURE) {
        throw new Error(`ZIP local header signature mismatch: ${entry.path}`);
    }
    const localFlags = archiveBuffer.readUInt16LE(offset + 6);
    const localMethod = archiveBuffer.readUInt16LE(offset + 8);
    if (localFlags !== entry.flags || localMethod !== entry.method) {
        throw new Error(`ZIP local/central flags or compression mismatch: ${entry.path}`);
    }
    // With a data descriptor the local CRC and sizes may legitimately be zero.
    if (!(localFlags & 0x0008) && (
        archiveBuffer.readUInt32LE(offset + 14) !== (entry.crc32 >>> 0) ||
        archiveBuffer.readUInt32LE(offset + 18) !== entry.compressedSize ||
        archiveBuffer.readUInt32LE(offset + 22) !== entry.uncompressedSize
    )) {
        throw new Error(`ZIP local/central metadata mismatch: ${entry.path}`);
    }
    const nameLength = archiveBuffer.readUInt16LE(offset + 26);
    const extraLength = archiveBuffer.readUInt16LE(offset + 28);
    const localName = archiveBuffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const normalizedLocalName = sanitizeArchivePath(localName);
    if (normalizedLocalName !== entry.path) {
        throw new Error(`ZIP local/central filename mismatch: ${entry.path} != ${normalizedLocalName}`);
    }
    const dataStart = offset + 30 + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataStart < 0 || dataEnd > archiveBuffer.length) {
        throw new Error(`ZIP entry data is outside archive: ${entry.path}`);
    }
    const compressed = archiveBuffer.subarray(dataStart, dataEnd);
    let data;
    if (entry.method === 0) {
        data = Buffer.from(compressed);
    } else if (entry.method === 8) {
        data = inflateRawSync(compressed, {
            maxOutputLength: Math.max(1, Math.min(limits.maxEntryBytes, entry.uncompressedSize || limits.maxEntryBytes)),
        });
    } else {
        throw new Error(`Unsupported ZIP compression method ${entry.method}: ${entry.path}`);
    }
    if (data.length !== entry.uncompressedSize) {
        throw new Error(`ZIP size mismatch for ${entry.path}: expected ${entry.uncompressedSize}, got ${data.length}.`);
    }
    const actualCrc = crc32(data);
    if ((actualCrc >>> 0) !== (entry.crc32 >>> 0)) {
        throw new Error(`ZIP CRC32 mismatch for ${entry.path}: expected ${entry.crc32 >>> 0}, got ${actualCrc >>> 0}.`);
    }
    return data;
}

export function parseProjectZipArchive(archiveBuffer, customLimits = {}) {
    const limits = { ...DEFAULT_LIMITS, ...customLimits };
    if (!Buffer.isBuffer(archiveBuffer) || archiveBuffer.length < 22) {
        throw new Error('PROJECT_ARCHIVE_INVALID: ZIP buffer is empty or truncated.');
    }
    if (archiveBuffer.length > limits.maxArchiveBytes) {
        throw new Error(`PROJECT_ARCHIVE_TOO_LARGE: archive exceeds ${limits.maxArchiveBytes} bytes.`);
    }
    if (archiveBuffer.readUInt32LE(0) !== ZIP_LOCAL_SIGNATURE) {
        throw new Error('PROJECT_ARCHIVE_INVALID: missing ZIP magic bytes PK\\x03\\x04.');
    }

    const eocdOffset = findEocd(archiveBuffer);
    if (eocdOffset < 0) throw new Error('PROJECT_ARCHIVE_INVALID: ZIP central directory not found.');

    const diskNumber = archiveBuffer.readUInt16LE(eocdOffset + 4);
    const centralDisk = archiveBuffer.readUInt16LE(eocdOffset + 6);
    const totalEntries = archiveBuffer.readUInt16LE(eocdOffset + 10);
    const centralSize = archiveBuffer.readUInt32LE(eocdOffset + 12);
    const centralOffset = archiveBuffer.readUInt32LE(eocdOffset + 16);
    if (diskNumber !== 0 || centralDisk !== 0) {
        throw new Error('PROJECT_ARCHIVE_UNSUPPORTED: multi-volume ZIP is not supported.');
    }
    if (totalEntries > limits.maxEntries) {
        throw new Error(`PROJECT_ARCHIVE_TOO_MANY_FILES: ${totalEntries} > ${limits.maxEntries}.`);
    }
    if (centralOffset + centralSize > archiveBuffer.length) {
        throw new Error('PROJECT_ARCHIVE_INVALID: central directory is outside archive bounds.');
    }

    const entries = [];
    const seenPaths = new Set();
    let cursor = centralOffset;
    let totalInflatedBytes = 0;
    for (let index = 0; index < totalEntries; index += 1) {
        if (cursor + 46 > archiveBuffer.length || archiveBuffer.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) {
            throw new Error(`PROJECT_ARCHIVE_INVALID: central entry ${index + 1} is malformed.`);
        }
        const flags = archiveBuffer.readUInt16LE(cursor + 8);
        const method = archiveBuffer.readUInt16LE(cursor + 10);
        const modTime = archiveBuffer.readUInt16LE(cursor + 12);
        const modDate = archiveBuffer.readUInt16LE(cursor + 14);
        const crc = archiveBuffer.readUInt32LE(cursor + 16);
        const compressedSize = archiveBuffer.readUInt32LE(cursor + 20);
        const uncompressedSize = archiveBuffer.readUInt32LE(cursor + 24);
        const nameLength = archiveBuffer.readUInt16LE(cursor + 28);
        const extraLength = archiveBuffer.readUInt16LE(cursor + 30);
        const commentLength = archiveBuffer.readUInt16LE(cursor + 32);
        const externalAttributes = archiveBuffer.readUInt32LE(cursor + 38);
        const localHeaderOffset = archiveBuffer.readUInt32LE(cursor + 42);
        const next = cursor + 46 + nameLength + extraLength + commentLength;
        if (next > archiveBuffer.length) throw new Error('PROJECT_ARCHIVE_INVALID: truncated central directory.');
        if (flags & 0x0001) throw new Error('PROJECT_ARCHIVE_UNSUPPORTED: encrypted ZIP entries are not supported.');
        if ([compressedSize, uncompressedSize, localHeaderOffset].includes(0xffffffff)) {
            throw new Error('PROJECT_ARCHIVE_UNSUPPORTED: ZIP64 archives are not supported for automatic code audit.');
        }
        if (uncompressedSize > limits.maxEntryBytes) {
            throw new Error(`PROJECT_ARCHIVE_ENTRY_TOO_LARGE: ${uncompressedSize} bytes in ${index + 1}/${totalEntries}.`);
        }
        totalInflatedBytes += uncompressedSize;
        if (totalInflatedBytes > limits.maxInflatedBytes) {
            throw new Error(`PROJECT_ARCHIVE_EXPANDED_TOO_LARGE: expanded archive exceeds ${limits.maxInflatedBytes} bytes.`);
        }

        const rawName = archiveBuffer.subarray(cursor + 46, cursor + 46 + nameLength);
        const decodedName = rawName.toString('utf8');
        const path = sanitizeArchivePath(decodedName);
        if (seenPaths.has(path)) {
            throw new Error(`PROJECT_ARCHIVE_INVALID: duplicate ZIP path ${path}.`);
        }
        seenPaths.add(path);
        const isDirectory = path.endsWith('/');
        if (!isDirectory && method !== 0 && method !== 8) {
            throw new Error(`PROJECT_ARCHIVE_UNSUPPORTED: compression method ${method} in ${path}.`);
        }
        entries.push({
            path,
            isDirectory,
            method,
            flags,
            modTime,
            modDate,
            crc32: crc,
            compressedSize,
            uncompressedSize,
            localHeaderOffset,
            externalAttributes,
            data: null,
        });
        cursor = next;
    }
    if (cursor !== centralOffset + centralSize) {
        throw new Error('PROJECT_ARCHIVE_INVALID: ZIP central directory size mismatch.');
    }

    return {
        archiveBuffer,
        entries,
        limits,
        totalInflatedBytes,
        readEntry(entry) {
            if (!entry || !entries.includes(entry)) throw new Error('Unknown ZIP entry.');
            if (!entry.data) entry.data = readZipEntryData(archiveBuffer, entry, limits);
            return entry.data;
        },
    };
}

// CRC-check every file without retaining all inflated entries simultaneously.
// selectProjectAuditFiles() may decode selected entries again afterwards.
export function verifyProjectZipEntries(parsedArchive) {
    for (const entry of parsedArchive.entries) {
        if (entry.isDirectory) continue;
        try {
            parsedArchive.readEntry(entry);
        } finally {
            entry.data = null;
        }
    }
    return parsedArchive;
}

export function isSensitiveProjectPath(path) {
    const normalized = String(path ?? '').replaceAll('\\', '/').toLowerCase();
    const parts = normalized.split('/').filter(Boolean);
    const base = parts.at(-1) || '';
    const ext = extensionOf(normalized);
    if (parts.some((part) => SENSITIVE_SEGMENTS.has(part))) return true;
    if (SENSITIVE_BASENAME_PATTERNS.some((pattern) => pattern.test(base))) return true;
    if (SENSITIVE_EXTENSIONS.has(ext)) return true;
    return false;
}

export function isAuditableProjectTextPath(path) {
    const normalized = String(path ?? '').replaceAll('\\', '/');
    if (!normalized || normalized.endsWith('/') || isSensitiveProjectPath(normalized)) return false;
    const base = normalized.split('/').at(-1)?.toLowerCase() || '';
    const ext = extensionOf(normalized);
    return ALLOWED_TEXT_EXTENSIONS.has(ext) || ALLOWED_TEXT_BASENAMES.has(base);
}

function looksLikeText(buffer) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) return true;
    const sample = buffer.subarray(0, Math.min(buffer.length, 64 * 1024));
    let control = 0;
    for (const byte of sample) {
        if (byte === 0) return false;
        if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
    }
    return control / sample.length < 0.015;
}

function pathPriority(path) {
    const value = String(path ?? '').toLowerCase();
    let score = 0;
    if (/\/src\//u.test(`/${value}`) || value.startsWith('src/')) score += 80;
    if (/\/tests?\//u.test(`/${value}`) || value.startsWith('test')) score += 45;
    if (/\/scripts?\//u.test(`/${value}`)) score += 30;
    if (/package\.json$/u.test(value)) score += 60;
    if (/botapplication\.js$/u.test(value)) score += 100;
    if (/readme|changes|commands|audit|architecture|event|scrap|dedup|poster|vision|telegram|vk|database/iu.test(value)) score += 25;
    if (/\.md$/u.test(value)) score += 5;
    return score;
}

export function selectProjectAuditFiles(parsedArchive, customLimits = {}) {
    const limits = { ...parsedArchive.limits, ...customLimits };
    const candidates = [];
    let skippedSensitive = 0;
    let skippedBinary = 0;
    for (const entry of parsedArchive.entries) {
        if (entry.isDirectory) continue;
        if (isSensitiveProjectPath(entry.path)) {
            skippedSensitive += 1;
            continue;
        }
        if (!isAuditableProjectTextPath(entry.path)) continue;
        const buffer = parsedArchive.readEntry(entry);
        if (!looksLikeText(buffer)) {
            skippedBinary += 1;
            entry.data = null;
            continue;
        }
        const content = buffer.toString('utf8').replace(/^\uFEFF/u, '');
        candidates.push({
            path: entry.path,
            bytes: buffer.length,
            chars: content.length,
            sha256: sha256(buffer),
            content,
            priority: pathPriority(entry.path),
        });
        // The candidate now owns only decoded text/hash. Keep no inflated ZIP
        // entry buffers alive while inspecting subsequent files.
        entry.data = null;
    }

    candidates.sort((left, right) =>
        right.priority - left.priority || left.path.localeCompare(right.path, 'en'),
    );

    const selected = [];
    let selectedChars = 0;
    for (const file of candidates) {
        if (selected.length >= limits.maxSelectedFiles) break;
        if (selectedChars + file.chars > limits.maxSelectedChars && selected.length) continue;
        selected.push(file);
        selectedChars += file.chars;
    }

    return {
        files: selected,
        totalCandidates: candidates.length,
        selectedChars,
        selectedBytes: selected.reduce((sum, file) => sum + file.bytes, 0),
        skippedSensitive,
        skippedBinary,
        truncated: selected.length < candidates.length,
        omittedCount: Math.max(0, candidates.length - selected.length),
    };
}

function lineNumberAt(text, index) {
    if (index <= 0) return 1;
    let lines = 1;
    for (let cursor = 0; cursor < index; cursor += 1) {
        if (text.charCodeAt(cursor) === 10) lines += 1;
    }
    return lines;
}

export function createProjectAuditChunks(files, customLimits = {}) {
    const limits = { ...DEFAULT_LIMITS, ...customLimits };
    const chunks = [];
    for (const file of Array.isArray(files) ? files : []) {
        const content = String(file?.content ?? '');
        if (content.length <= limits.maxChunkChars) {
            chunks.push({
                path: file.path,
                sha256: file.sha256,
                startLine: 1,
                endLine: content.split('\n').length,
                content,
                chars: content.length,
                part: 1,
                parts: 1,
            });
            continue;
        }
        const local = [];
        let start = 0;
        while (start < content.length) {
            let end = Math.min(content.length, start + limits.maxChunkChars);
            if (end < content.length) {
                const newline = content.lastIndexOf('\n', end);
                if (newline > start + Math.floor(limits.maxChunkChars * 0.65)) end = newline + 1;
            }
            const piece = content.slice(start, end);
            local.push({ start, end, content: piece });
            if (end >= content.length) break;
            start = Math.max(start + 1, end - limits.chunkOverlapChars);
        }
        for (let index = 0; index < local.length; index += 1) {
            const item = local[index];
            chunks.push({
                path: file.path,
                sha256: file.sha256,
                startLine: lineNumberAt(content, item.start),
                endLine: lineNumberAt(content, item.end),
                content: item.content,
                chars: item.content.length,
                part: index + 1,
                parts: local.length,
            });
        }
    }
    return chunks;
}

export function createProjectAuditBatches(chunks, customLimits = {}) {
    const limits = { ...DEFAULT_LIMITS, ...customLimits };
    const batches = [];
    let current = [];
    let currentChars = 0;
    for (const chunk of Array.isArray(chunks) ? chunks : []) {
        const weight = Number(chunk?.chars ?? String(chunk?.content ?? '').length) + 500;
        if (current.length && (
            current.length >= limits.maxBatchChunks ||
            currentChars + weight > limits.maxBatchChars
        )) {
            batches.push(current);
            current = [];
            currentChars = 0;
        }
        current.push(chunk);
        currentChars += weight;
    }
    if (current.length) batches.push(current);
    return batches;
}

export function buildProjectAuditBatchText(batch, { jobId = '', task = '' } = {}) {
    const header = [
        `PROJECT_AUDIT_JOB=${jobId}`,
        `TASK=${String(task ?? '').trim()}`,
        `FILES_IN_BATCH=${Array.isArray(batch) ? batch.length : 0}`,
        '',
    ].join('\n');
    const body = (Array.isArray(batch) ? batch : []).map((chunk) => [
        `===== FILE ${chunk.path} | sha256=${chunk.sha256} | lines=${chunk.startLine}-${chunk.endLine} | part=${chunk.part}/${chunk.parts} =====`,
        chunk.content,
        `===== END FILE ${chunk.path} =====`,
        '',
    ].join('\n')).join('\n');
    return header + body;
}

function stripJsonFence(value) {
    let text = String(value ?? '').trim();
    text = text.replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '').trim();
    return text;
}

export function parseJsonObjectFromModel(value) {
    const source = stripJsonFence(value);
    try {
        const parsed = JSON.parse(source);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}

    const start = source.indexOf('{');
    if (start < 0) throw new Error('PROJECT_AUDIT_MODEL_JSON: response does not contain a JSON object.');
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
        const char = source[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === '{') depth += 1;
        if (char === '}') depth -= 1;
        if (depth === 0) {
            const candidate = source.slice(start, index + 1);
            try {
                const parsed = JSON.parse(candidate);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
            } catch {}
            break;
        }
    }
    throw new Error('PROJECT_AUDIT_MODEL_JSON: could not parse model JSON object.');
}

export function normalizeAuditFindings(payload, { batchIndex = 0 } = {}) {
    const source = Array.isArray(payload?.findings) ? payload.findings : [];
    return source.slice(0, 30).map((item) => ({
        batchIndex,
        severity: String(item?.severity ?? 'medium').slice(0, 24),
        path: String(item?.path ?? '').replaceAll('\\', '/').slice(0, 500),
        location: String(item?.location ?? item?.symbol ?? '').slice(0, 500),
        title: String(item?.title ?? item?.summary ?? '').slice(0, 700),
        evidence: String(item?.evidence ?? '').slice(0, 4_000),
        fix: String(item?.fix ?? item?.proposed_fix ?? '').slice(0, 4_000),
    })).filter((item) => item.path || item.title);
}

function countOccurrences(haystack, needle) {
    if (!needle) return 0;
    let count = 0;
    let from = 0;
    while (true) {
        const index = haystack.indexOf(needle, from);
        if (index < 0) return count;
        count += 1;
        from = index + needle.length;
    }
}

export function applyStructuredFileEdits(file, patchPayload) {
    const original = String(file?.content ?? '');
    const expectedSha256 = String(patchPayload?.expectedSha256 ?? patchPayload?.expected_sha256 ?? '').trim();
    if (expectedSha256 && expectedSha256 !== file.sha256) {
        throw new Error(`PROJECT_AUDIT_SHA_MISMATCH: ${file.path}`);
    }
    const edits = Array.isArray(patchPayload?.edits) ? patchPayload.edits : [];
    if (!edits.length) return { content: original, applied: 0, skipped: 0, errors: [] };
    let content = original;
    let applied = 0;
    const errors = [];
    for (let index = 0; index < Math.min(edits.length, 24); index += 1) {
        const edit = edits[index] || {};
        const oldText = String(edit.old ?? edit.before ?? '');
        const newText = String(edit.new ?? edit.after ?? '');
        if (!oldText || oldText === newText) {
            errors.push(`edit ${index + 1}: empty/unchanged old snippet`);
            continue;
        }
        const occurrences = countOccurrences(content, oldText);
        if (occurrences !== 1) {
            errors.push(`edit ${index + 1}: old snippet occurrences=${occurrences}`);
            continue;
        }
        content = content.replace(oldText, newText);
        applied += 1;
    }
    return { content, applied, skipped: errors.length, errors };
}

function crc32Table() {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
}
const CRC32_TABLE = crc32Table();

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function currentDosTimeDate(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    const dosTime = ((date.getHours() & 0x1f) << 11) |
        ((date.getMinutes() & 0x3f) << 5) |
        ((Math.floor(date.getSeconds() / 2)) & 0x1f);
    const dosDate = (((year - 1980) & 0x7f) << 9) |
        (((date.getMonth() + 1) & 0x0f) << 5) |
        (date.getDate() & 0x1f);
    return { dosTime, dosDate };
}

export function buildPatchedProjectZip(parsedArchive, {
    replacements = new Map(),
    additions = new Map(),
} = {}) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const all = [];
    for (const entry of parsedArchive.entries) {
        const replacement = replacements.get(entry.path);
        let data = replacement !== undefined
            ? Buffer.from(String(replacement), 'utf8')
            : parsedArchive.readEntry(entry);
        all.push({
            path: entry.path,
            isDirectory: entry.isDirectory,
            data,
            method: entry.isDirectory || data.length === 0 ? 0 : 8,
            modTime: entry.modTime,
            modDate: entry.modDate,
            externalAttributes: entry.externalAttributes,
        });
    }
    for (const [rawPath, rawContent] of additions.entries()) {
        const path = sanitizeArchivePath(rawPath);
        if (parsedArchive.entries.some((entry) => entry.path === path)) continue;
        const { dosTime, dosDate } = currentDosTimeDate();
        const data = Buffer.isBuffer(rawContent) ? rawContent : Buffer.from(String(rawContent), 'utf8');
        all.push({ path, isDirectory: path.endsWith('/'), data, method: path.endsWith('/') || !data.length ? 0 : 8, modTime: dosTime, modDate: dosDate, externalAttributes: 0 });
    }

    for (const item of all) {
        const name = Buffer.from(item.path, 'utf8');
        const data = item.isDirectory ? Buffer.alloc(0) : item.data;
        const compressed = item.method === 8 ? deflateRawSync(data, { level: 6 }) : Buffer.from(data);
        const crc = crc32(data);
        const local = Buffer.alloc(30 + name.length);
        local.writeUInt32LE(ZIP_LOCAL_SIGNATURE, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(item.method, 8);
        local.writeUInt16LE(item.modTime || 0, 10);
        local.writeUInt16LE(item.modDate || 0, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        name.copy(local, 30);
        localParts.push(local, compressed);

        const central = Buffer.alloc(46 + name.length);
        central.writeUInt32LE(ZIP_CENTRAL_SIGNATURE, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(item.method, 10);
        central.writeUInt16LE(item.modTime || 0, 12);
        central.writeUInt16LE(item.modDate || 0, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(item.externalAttributes || (item.isDirectory ? 0x10 : 0), 38);
        central.writeUInt32LE(offset, 42);
        name.copy(central, 46);
        centralParts.push(central);
        offset += local.length + compressed.length;
    }

    const centralOffset = offset;
    const centralBuffer = Buffer.concat(centralParts);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(ZIP_EOCD_SIGNATURE, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(all.length, 8);
    eocd.writeUInt16LE(all.length, 10);
    eocd.writeUInt32LE(centralBuffer.length, 12);
    eocd.writeUInt32LE(centralOffset, 16);
    eocd.writeUInt16LE(0, 20);
    return Buffer.concat([...localParts, centralBuffer, eocd]);
}

export function findArchiveCommonRoot(entries) {
    const roots = new Set((Array.isArray(entries) ? entries : [])
        .filter((entry) => !entry?.isDirectory)
        .map((entry) => String(entry.path ?? '').split('/')[0])
        .filter(Boolean));
    return roots.size === 1 ? [...roots][0] : '';
}

export function sanitizeAuditOutputPath(path, commonRoot = '') {
    const normalized = sanitizeArchivePath(path);
    if (isSensitiveProjectPath(normalized)) throw new Error(`PROJECT_AUDIT_FORBIDDEN_PATH: ${normalized}`);
    const ext = extensionOf(normalized);
    if (!ALLOWED_TEXT_EXTENSIONS.has(ext) && !ALLOWED_TEXT_BASENAMES.has(normalized.split('/').at(-1)?.toLowerCase() || '')) {
        throw new Error(`PROJECT_AUDIT_UNSUPPORTED_OUTPUT: ${normalized}`);
    }
    if (commonRoot && !normalized.startsWith(`${commonRoot}/`)) return `${commonRoot}/${normalized}`;
    return normalized;
}

export function summarizeProjectManifest(selection) {
    return (selection?.files || []).map((file) => ({
        path: file.path,
        bytes: file.bytes,
        chars: file.chars,
        sha256: file.sha256,
    }));
}


export function validatePatchedTextFiles(replacements = new Map()) {
    const results = [];
    const tempRoot = mkdtempSync(join(tmpdir(), 'gigorave-audit-check-'));
    try {
        let index = 0;
        for (const [path, rawContent] of replacements.entries()) {
            const content = String(rawContent ?? '');
            const ext = extensionOf(path);
            if (ext === '.json') {
                try {
                    JSON.parse(content);
                    results.push({ path, ok: true, kind: 'json' });
                } catch (error) {
                    results.push({ path, ok: false, kind: 'json', error: String(error?.message ?? error) });
                }
                continue;
            }
            if (!['.js', '.mjs', '.cjs'].includes(ext)) continue;
            index += 1;
            const tempPath = join(tempRoot, `file-${index}${ext}`);
            writeFileSync(tempPath, content, 'utf8');
            const checked = spawnSync(process.execPath, ['--check', tempPath], {
                encoding: 'utf8',
                timeout: 20_000,
                windowsHide: true,
            });
            const error = String(checked.stderr || checked.stdout || '').trim();
            results.push({
                path,
                ok: checked.status === 0 && !checked.error,
                kind: 'node-check',
                error: checked.error ? String(checked.error?.message ?? checked.error) : error.slice(0, 4000),
            });
        }
    } finally {
        try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
    }
    return results;
}

export const PROJECT_ARCHIVE_AUDIT_LIMITS = DEFAULT_LIMITS;
