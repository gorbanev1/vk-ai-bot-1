import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getAiAuditExcludedEnvNames } from './providerKeyAudit.js';

const clean = (value) => String(value ?? '').trim();

export const AI_QUOTA_QUARANTINE_START = '# ==================== GIGORAVE AI QUOTA QUARANTINE ====================';
export const AI_QUOTA_QUARANTINE_END = '# ================== END GIGORAVE AI QUOTA QUARANTINE =================';

function stamp(date = new Date()) {
    return date.toISOString().replace(/[:.]/gu, '-');
}

export function isDefinitiveInvalidCredentialResult(row = {}) {
    const status = Number(row.status || 0);
    const message = clean(row.error).toLowerCase();
    if (/api key not valid|api_key_invalid|incorrect api key|invalid api key|api key is invalid|invalid x-api-key|invalid x-api key/u.test(message)) {
        return true;
    }
    if (status !== 401) return false;
    return /key|token|credential|unauthoriz|authentication/u.test(message) || !message;
}

export function isNoFundsCredentialResult(row = {}) {
    const status = Number(row.status || 0);
    const message = clean(row.error || row.message).toLowerCase();
    if (status === 402) return true;
    if (!message) return false;
    if (/rate[ -]?limit|too many requests|requests per (?:minute|second)|rpm|tpm/u.test(message)) return false;
    return /no credits? remaining|insufficient[_ -]?quota|insufficient (?:credits?|balance|funds)|credit balance|billing hard limit|payment required|add credits?|purchase credits?|current quota.*(?:billing|credits?)|quota.*(?:billing|credits?)|exceeded your current quota/u.test(message);
}

function auditFailureRows(report = {}) {
    return [
        ...(Array.isArray(report?.retryCandidates) ? report.retryCandidates : []),
        ...(Array.isArray(report?.keyAudit?.results) ? report.keyAudit.results : []),
        ...(Array.isArray(report?.keySecondSweep?.results)
            ? report.keySecondSweep.results.flatMap((row) => Array.isArray(row?.attempts) ? row.attempts.map((attempt) => ({ ...attempt, envName: row.envName, provider: row.provider })) : [])
            : []),
    ];
}

export function collectQuotaExhaustedEnvNames(report = {}, env = process.env) {
    const protectedNames = getAiAuditExcludedEnvNames(env);
    const working = new Set((report?.workingModes || []).map((row) => clean(row?.envName)).filter(Boolean));
    const invalid = new Set(auditFailureRows(report).filter(isDefinitiveInvalidCredentialResult).map((row) => clean(row?.envName)).filter(Boolean));
    const names = new Set();
    for (const row of auditFailureRows(report)) {
        const name = clean(row?.envName);
        if (!name || protectedNames.has(name) || working.has(name) || invalid.has(name)) continue;
        if (isNoFundsCredentialResult(row)) names.add(name);
    }
    return [...names].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

export function collectDefinitiveDeadEnvNames(report = {}, env = process.env) {
    const protectedNames = getAiAuditExcludedEnvNames(env);
    const names = new Set();
    for (const row of report?.keyAudit?.results || []) {
        const name = clean(row?.envName);
        if (!name || protectedNames.has(name)) continue;
        if (isDefinitiveInvalidCredentialResult(row)) names.add(name);
    }
    return [...names].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

function envAssignmentName(line) {
    const match = String(line ?? '').match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u);
    return match?.[1] || '';
}

function envAssignmentRhs(line) {
    const raw = String(line ?? '');
    const index = raw.indexOf('=');
    return index >= 0 ? raw.slice(index + 1) : '';
}

function splitEnvDocument(source) {
    const hadTrailingNewline = /\r?\n$/u.test(source);
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const lines = source.split(/\r?\n/u);
    if (hadTrailingNewline && lines.at(-1) === '') lines.pop();
    return { lines, eol, hadTrailingNewline };
}

function quarantineRange(lines) {
    const start = lines.findIndex((line) => String(line).trim() === AI_QUOTA_QUARANTINE_START);
    if (start < 0) return { start: -1, end: -1 };
    const relativeEnd = lines.slice(start + 1).findIndex((line) => String(line).trim() === AI_QUOTA_QUARANTINE_END);
    return { start, end: relativeEnd < 0 ? lines.length - 1 : start + 1 + relativeEnd };
}

function parseQuarantineEntries(lines) {
    const { start, end } = quarantineRange(lines);
    const entries = new Map();
    if (start < 0) return entries;
    for (let index = start + 1; index < end; index += 1) {
        const match = String(lines[index] ?? '').match(/^\s*#\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/u);
        if (!match) continue;
        entries.set(match[1], match[2]);
    }
    return entries;
}

function stripQuarantineBlock(lines) {
    const { start, end } = quarantineRange(lines);
    if (start < 0) return [...lines];
    const before = lines.slice(0, start);
    const after = lines.slice(end + 1);
    while (before.length && !String(before.at(-1)).trim()) before.pop();
    while (after.length && !String(after[0]).trim()) after.shift();
    return after.length ? [...before, '', ...after] : before;
}

function buildQuarantineBlock(entries) {
    if (!entries.size) return [];
    const sorted = [...entries.entries()].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }));
    return [
        AI_QUOTA_QUARANTINE_START,
        '# AUTO-MANAGED: ключи без денег/кредитов. Они закомментированы и не загружаются в runtime.',
        '# Проверка: 5 и 20 числа каждого месяца. После 5 подтверждённых quota-проходов ключ удаляется.',
        '# Не удаляй разделители вручную: состояние проходов хранится в SQLite и переживает перезапуски бота.',
        ...sorted.map(([name, rhs]) => `# ${name}=${rhs}`),
        AI_QUOTA_QUARANTINE_END,
    ];
}

function dotenvValue(name, rhs) {
    const raw = clean(rhs);
    if (!raw) return '';
    const quote = raw[0];
    if ((quote === '"' || quote === "'") && raw.at(-1) === quote) {
        const body = raw.slice(1, -1);
        if (quote === "'") return body;
        return body
            .replace(/\\n/gu, '\n')
            .replace(/\\r/gu, '\r')
            .replace(/\\t/gu, '\t')
            .replace(/\\"/gu, '"')
            .replace(/\\\\/gu, '\\');
    }
    const commentIndex = raw.search(/\s+#/u);
    return clean(commentIndex >= 0 ? raw.slice(0, commentIndex) : raw);
}

async function readEnvDocument(directory) {
    const envPath = resolve(directory, '.env');
    const source = await readFile(envPath, 'utf8');
    return { envPath, source, ...splitEnvDocument(source) };
}

async function writeEnvDocument({ envPath, lines, eol, hadTrailingNewline }) {
    await writeFile(envPath, lines.join(eol) + (hadTrailingNewline ? eol : ''), 'utf8');
}

export async function readQuotaQuarantinedKeys({ directory = process.cwd() } = {}) {
    const { envPath, lines } = await readEnvDocument(directory);
    const entries = parseQuarantineEntries(lines);
    return {
        envPath,
        entries: [...entries.entries()].map(([envName, rhs]) => ({ envName, rhs, secret: dotenvValue(envName, rhs) })),
    };
}

export async function quarantineQuotaEnvNames({
    directory = process.cwd(),
    envNames = [],
    runtimeEnv = process.env,
    now = new Date(),
    auditOutDir = '',
    protectExcluded = true,
} = {}) {
    const requested = new Set((envNames || []).map(clean).filter(Boolean));
    const protectedNames = protectExcluded ? getAiAuditExcludedEnvNames(runtimeEnv) : new Set();
    for (const name of protectedNames) requested.delete(name);
    const { envPath, lines, eol, hadTrailingNewline } = await readEnvDocument(directory);
    if (!requested.size) return { ok: true, envPath, quarantined: [], missing: [], backupPath: '', changed: false };

    const entries = parseQuarantineEntries(lines);
    const baseLines = stripQuarantineBlock(lines);
    const kept = [];
    const quarantined = [];
    for (const line of baseLines) {
        const name = envAssignmentName(line);
        if (name && requested.has(name)) {
            entries.set(name, envAssignmentRhs(line));
            quarantined.push(name);
            continue;
        }
        kept.push(line);
    }
    for (const name of requested) {
        if (entries.has(name) && !quarantined.includes(name)) quarantined.push(name);
    }
    const missing = [...requested].filter((name) => !entries.has(name));
    const block = buildQuarantineBlock(entries);
    while (kept.length && !String(kept.at(-1)).trim()) kept.pop();
    const output = block.length ? [...kept, '', ...block] : kept;
    const changed = output.join('\n') !== lines.join('\n');
    let backupPath = '';
    if (changed) {
        backupPath = resolve(directory, `.env.before-ai-quota-quarantine-${stamp(now)}.bak`);
        await copyFile(envPath, backupPath);
        await writeEnvDocument({ envPath, lines: output, eol, hadTrailingNewline });
    }
    for (const name of quarantined) delete runtimeEnv[name];

    if (auditOutDir) {
        await mkdir(auditOutDir, { recursive: true });
        await writeFile(resolve(auditOutDir, 'quota_quarantine.json'), JSON.stringify({
            status: 'completed',
            quarantinedAt: now.toISOString(),
            envPath,
            backupPath,
            quarantined: [...new Set(quarantined)].sort(),
            missing,
        }, null, 2), 'utf8');
    }
    return { ok: true, envPath, quarantined: [...new Set(quarantined)].sort(), missing, backupPath, changed };
}

export async function quarantineQuotaKeysFromReport({
    report,
    directory = process.cwd(),
    runtimeEnv = process.env,
    now = new Date(),
    auditOutDir = report?.outDir || '',
} = {}) {
    const envNames = collectQuotaExhaustedEnvNames(report, runtimeEnv);
    return quarantineQuotaEnvNames({ directory, envNames, runtimeEnv, now, auditOutDir });
}

export async function recoverQuotaKeysFromLatestCleanupBackup({
    report,
    directory = process.cwd(),
    runtimeEnv = process.env,
    now = new Date(),
} = {}) {
    const requested = new Set(collectQuotaExhaustedEnvNames(report, runtimeEnv));
    if (!requested.size) return { ok: true, recovered: [], sourceBackup: '', changed: false };

    const current = await readEnvDocument(directory);
    const currentQuarantine = parseQuarantineEntries(current.lines);
    const activeNames = new Set(current.lines.map(envAssignmentName).filter(Boolean));
    const missing = [...requested].filter((name) => !activeNames.has(name) && !currentQuarantine.has(name));
    if (!missing.length) return { ok: true, recovered: [], sourceBackup: '', changed: false };

    const backups = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /^\.env\.before-ai-key-cleanup-.*\.bak$/u.test(entry.name))
        .map((entry) => entry.name)
        .sort()
        .reverse();
    if (!backups.length) return { ok: false, recovered: [], sourceBackup: '', changed: false, error: 'cleanup backup not found' };

    const recovered = new Map();
    let sourceBackup = '';
    for (const backupName of backups) {
        const backupPath = resolve(directory, backupName);
        const backupLines = splitEnvDocument(await readFile(backupPath, 'utf8')).lines;
        for (const line of backupLines) {
            const name = envAssignmentName(line);
            if (!name || !missing.includes(name) || recovered.has(name)) continue;
            recovered.set(name, envAssignmentRhs(line));
            sourceBackup ||= backupPath;
        }
        if (recovered.size === missing.length) break;
    }
    if (!recovered.size) return { ok: false, recovered: [], sourceBackup: '', changed: false, error: 'quota keys not found in cleanup backups' };

    for (const [name, rhs] of recovered) currentQuarantine.set(name, rhs);
    const baseLines = stripQuarantineBlock(current.lines);
    while (baseLines.length && !String(baseLines.at(-1)).trim()) baseLines.pop();
    const output = [...baseLines, '', ...buildQuarantineBlock(currentQuarantine)];
    const safetyBackup = resolve(directory, `.env.before-ai-quota-recovery-${stamp(now)}.bak`);
    await copyFile(current.envPath, safetyBackup);
    await writeEnvDocument({ ...current, lines: output });
    for (const name of recovered.keys()) delete runtimeEnv[name];
    return {
        ok: true,
        recovered: [...recovered.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
        sourceBackup,
        safetyBackup,
        changed: true,
    };
}

export async function restoreQuotaEnvName({ directory = process.cwd(), envName, runtimeEnv = process.env } = {}) {
    const name = clean(envName);
    const { envPath, lines, eol, hadTrailingNewline } = await readEnvDocument(directory);
    const entries = parseQuarantineEntries(lines);
    if (!name || !entries.has(name)) return { ok: false, envPath, restored: false, error: 'quota key not found' };
    const rhs = entries.get(name);
    entries.delete(name);
    const baseLines = stripQuarantineBlock(lines);
    while (baseLines.length && !String(baseLines.at(-1)).trim()) baseLines.pop();
    const block = buildQuarantineBlock(entries);
    const output = [...baseLines, `${name}=${rhs}`, ...(block.length ? ['', ...block] : [])];
    await writeEnvDocument({ envPath, lines: output, eol, hadTrailingNewline });
    runtimeEnv[name] = dotenvValue(name, rhs);
    return { ok: true, envPath, restored: true, envName: name };
}

export async function removeQuotaEnvName({ directory = process.cwd(), envName, runtimeEnv = process.env, now = new Date() } = {}) {
    const name = clean(envName);
    const { envPath, lines, eol, hadTrailingNewline } = await readEnvDocument(directory);
    const entries = parseQuarantineEntries(lines);
    if (!name || !entries.has(name)) return { ok: false, envPath, removed: false, error: 'quota key not found', backupPath: '' };
    entries.delete(name);
    const baseLines = stripQuarantineBlock(lines);
    while (baseLines.length && !String(baseLines.at(-1)).trim()) baseLines.pop();
    const block = buildQuarantineBlock(entries);
    const output = block.length ? [...baseLines, '', ...block] : baseLines;
    const backupPath = resolve(directory, `.env.before-ai-quota-delete-${stamp(now)}.bak`);
    await copyFile(envPath, backupPath);
    await writeEnvDocument({ envPath, lines: output, eol, hadTrailingNewline });
    delete runtimeEnv[name];
    return { ok: true, envPath, removed: true, envName: name, backupPath };
}

export function collectConfirmedDeadEnvNames(report = {}, env = process.env) {
    const protectedNames = getAiAuditExcludedEnvNames(env);
    const quotaNames = new Set(collectQuotaExhaustedEnvNames(report, env));
    const sweepRows = Array.isArray(report?.keySecondSweep?.results)
        ? report.keySecondSweep.results
        : [];
    if (!sweepRows.length) return collectDefinitiveDeadEnvNames(report, env).filter((name) => !quotaNames.has(name));

    const names = new Set();
    for (const row of sweepRows) {
        const name = clean(row?.envName);
        if (!name || protectedNames.has(name) || quotaNames.has(name)) continue;
        if (clean(row?.verdict) === 'dead-confirmed') names.add(name);
    }

    for (const name of collectDefinitiveDeadEnvNames(report, env)) {
        if (!quotaNames.has(name)) names.add(name);
    }
    return [...names].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

export async function removeEnvNamesFromDotEnv({
    directory = process.cwd(),
    envNames = [],
    runtimeEnv = process.env,
    now = new Date(),
    auditOutDir = '',
    protectExcluded = true,
} = {}) {
    const requested = new Set((envNames || []).map(clean).filter(Boolean));
    const protectedNames = protectExcluded ? getAiAuditExcludedEnvNames(runtimeEnv) : new Set();
    for (const name of protectedNames) requested.delete(name);
    const envPath = resolve(directory, '.env');
    if (!requested.size) {
        return { ok: true, envPath, removed: [], missing: [], backupPath: '', cleanupLogPath: '', changed: false };
    }

    let source;
    try {
        source = await readFile(envPath, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return { ok: false, envPath, removed: [], missing: [...requested], backupPath: '', cleanupLogPath: '', changed: false, error: '.env не найден.' };
        }
        throw error;
    }

    const hadTrailingNewline = /\r?\n$/u.test(source);
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const lines = source.split(/\r?\n/u);
    if (hadTrailingNewline && lines.at(-1) === '') lines.pop();
    const removed = [];
    const kept = [];
    for (const line of lines) {
        const name = envAssignmentName(line);
        if (name && requested.has(name)) {
            removed.push(name);
            continue;
        }
        kept.push(line);
    }
    const removedUnique = [...new Set(removed)].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    const missing = [...requested].filter((name) => !removedUnique.includes(name));
    if (!removedUnique.length) {
        return { ok: true, envPath, removed: [], missing, backupPath: '', cleanupLogPath: '', changed: false };
    }

    const backupPath = resolve(directory, `.env.before-ai-key-cleanup-${stamp(now)}.bak`);
    await copyFile(envPath, backupPath);
    await writeFile(envPath, kept.join(eol) + (hadTrailingNewline ? eol : ''), 'utf8');
    for (const name of removedUnique) delete runtimeEnv[name];

    let cleanupLogPath = '';
    if (auditOutDir) {
        await mkdir(auditOutDir, { recursive: true });
        cleanupLogPath = resolve(auditOutDir, 'env_cleanup.json');
        await writeFile(cleanupLogPath, JSON.stringify({
            status: 'completed',
            cleanedAt: now.toISOString(),
            envPath,
            backupPath,
            removed: removedUnique,
            missing,
            protected: [...protectedNames],
        }, null, 2), 'utf8');
    }
    return { ok: true, envPath, removed: removedUnique, missing, backupPath, cleanupLogPath, changed: true };
}

export async function cleanupConfirmedDeadKeysFromReport({
    report,
    directory = process.cwd(),
    runtimeEnv = process.env,
    now = new Date(),
    auditOutDir = report?.outDir || '',
} = {}) {
    const envNames = collectConfirmedDeadEnvNames(report, runtimeEnv);
    return removeEnvNamesFromDotEnv({ directory, envNames, runtimeEnv, now, auditOutDir });
}

export async function cleanupDefinitiveDeadKeysFromReport({
    report,
    directory = process.cwd(),
    runtimeEnv = process.env,
    now = new Date(),
    auditOutDir = report?.outDir || '',
} = {}) {
    const envNames = collectDefinitiveDeadEnvNames(report, runtimeEnv);
    return removeEnvNamesFromDotEnv({ directory, envNames, runtimeEnv, now, auditOutDir });
}

export async function findLatestCompletedAuditReport({ directory = process.cwd() } = {}) {
    const root = resolve(directory, 'AI_FULL_AUDIT_RESULTS');
    let entries = [];
    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
    const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
    for (const name of dirs) {
        const outDir = resolve(root, name);
        try {
            const done = JSON.parse(await readFile(resolve(outDir, 'AUDIT_DONE.json'), 'utf8'));
            if (done?.status !== 'completed') continue;
            const report = JSON.parse(await readFile(resolve(outDir, 'report.json'), 'utf8'));
            return { report, outDir };
        } catch {
            // Try the next older completed folder.
        }
    }
    return null;
}
