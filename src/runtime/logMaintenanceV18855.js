import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { BOT_PATCH_VERSION } from '../shared/buildVersion.js';

// Backward-compatible exports retained for older tests/imports. Their values
// now point at the current build boundary rather than a one-off V188.55 value.
export const LOG_CLEANUP_BUILD_V18855 = BOT_PATCH_VERSION;
export const LOG_CLEANUP_MARKER_V18855 = '.log-cleanup-build.done.json';

const DEFAULT_TARGETS = Object.freeze([
    'data/logs',
    'data/audit/media',
    'data/ai-token-usage',
    'data/event-ingest-audit.jsonl',
    'AI_FULL_AUDIT_RESULTS',
    'GRAPHICS_MATRIX_RESULTS',
]);

function normalizeTarget(root, relativePath) {
    const base = resolve(root);
    const target = resolve(base, relativePath);
    const prefix = `${base}${sep}`;
    if (target !== base && !target.startsWith(prefix)) {
        throw new Error(`Unsafe log cleanup target: ${relativePath}`);
    }
    return target;
}

function markerPath(root) {
    return resolve(root, 'data', LOG_CLEANUP_MARKER_V18855);
}

function readMarker(path) {
    if (!existsSync(path)) return null;
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return { build: 'unreadable-marker' };
    }
}

/**
 * Build-scoped volatile-log cleanup.
 *
 * The startup path must stay bounded even when data/logs is hundreds of MB.
 * Therefore active volatile paths are atomically renamed out of the way here;
 * physical deletion is explicitly deferred until the application is ready.
 */
export function clearPreviouslyProcessedLogsV18855({
    root = process.cwd(),
    logger = console,
    force = String(process.env.FORCE_BUILD_LOG_CLEANUP || process.env.FORCE_V18855_LOG_CLEANUP || '').trim() === '1',
    targets = DEFAULT_TARGETS,
    build = BOT_PATCH_VERSION,
} = {}) {
    const base = resolve(root);
    const marker = markerPath(base);
    const previous = readMarker(marker);
    const currentBuild = String(build || BOT_PATCH_VERSION).trim() || BOT_PATCH_VERSION;
    if (!force && previous?.build === currentBuild) {
        return {
            skipped: true,
            reason: 'already-cleaned-for-build',
            marker,
            removed: [],
            rotated: [],
            build: currentBuild,
        };
    }

    const removed = [];
    const rotated = [];
    const missing = [];
    const errors = [];
    const suffixBase = `${Date.now()}-${process.pid}-${process.hrtime.bigint().toString(36)}`;

    for (const [index, relativePath] of targets.entries()) {
        try {
            const target = normalizeTarget(base, relativePath);
            if (!existsSync(target)) {
                missing.push(relativePath);
                continue;
            }
            const rotatedPath = `${target}.old-${suffixBase}-${index + 1}`;
            renameSync(target, rotatedPath);
            removed.push(relativePath);
            rotated.push({ relativePath, path: rotatedPath });

            // The logging subsystem may write immediately after import. Keep a
            // fresh active log root available without waiting for old cleanup.
            if (relativePath === 'data/logs') {
                mkdirSync(target, { recursive: true });
            }
        } catch (error) {
            errors.push({
                target: relativePath,
                error: String(error?.message || error).slice(0, 1000),
            });
        }
    }

    const record = {
        build: currentBuild,
        previousBuild: String(previous?.build || ''),
        cleanedAt: new Date().toISOString(),
        cleanupMode: 'atomic-rotate-then-detached-delete',
        removed,
        rotated: rotated.map((item) => item.relativePath),
        missing,
        errors,
        invariant: 'volatile-logs-only; db/wal/shm/posters/raw-source/backups/journals/checkpoints untouched',
    };

    try {
        mkdirSync(dirname(marker), { recursive: true });
        writeFileSync(marker, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    } catch (error) {
        errors.push({
            target: LOG_CLEANUP_MARKER_V18855,
            error: String(error?.message || error).slice(0, 1000),
        });
    }

    const log = errors.length ? logger?.warn : logger?.log;
    log?.call(
        logger,
        '[BUILD LOG CLEANUP]',
        `build=${currentBuild}`,
        `previous=${String(previous?.build || 'none')}`,
        `rotated=${rotated.length}`,
        `missing=${missing.length}`,
        `errors=${errors.length}`,
        `marker=${marker}`,
    );

    return {
        skipped: false,
        marker,
        removed,
        rotated,
        missing,
        errors,
        build: currentBuild,
    };
}

/**
 * Delete rotated volatile trees only after readiness. This function is async
 * by design; callers should detach it so filesystem cleanup cannot gate ingress.
 */
export async function removeRotatedLogsDetachedV18868({
    rotated = [],
    logger = console,
} = {}) {
    const candidates = (Array.isArray(rotated) ? rotated : [])
        .map((item) => typeof item === 'string' ? item : item?.path)
        .map((value) => String(value || '').trim())
        .filter(Boolean);
    if (!candidates.length) return { removed: 0, errors: [] };

    const results = await Promise.allSettled(candidates.map((target) => (
        rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    )));
    const errors = [];
    let removed = 0;
    for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        if (result.status === 'fulfilled') {
            removed += 1;
        } else {
            errors.push({ target: candidates[index], error: String(result.reason?.message || result.reason).slice(0, 1000) });
        }
    }
    const log = errors.length ? logger?.warn : logger?.log;
    log?.call(logger, '[BUILD LOG CLEANUP DETACHED]', `removed=${removed}`, `errors=${errors.length}`);
    return { removed, errors };
}

