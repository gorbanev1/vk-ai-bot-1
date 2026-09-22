import { EVENT_DEDUPE_ALGORITHM_VERSION } from './eventDuplicateResolution.js';
import { buildEventSnapshotQualityAudit } from './eventSnapshotQualityAudit.js';
import { resolveRuntimeDataDirectory } from '../../infrastructure/database/runtimePaths.js';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/*
 * V103: версия 2 инвалидирует старые verified snapshot-файлы, которые могли
 * быть собраны до последних исправлений глубокого dedupe. Иначе бот способен
 * продолжать раздавать физически устаревший кэш даже после обновления кода.
 */
export const EVENT_VERIFIED_SNAPSHOT_VERSION = 8;
export const EVENT_VERIFIED_SNAPSHOT_FILE = join(resolveRuntimeDataDirectory(), 'event-verified-snapshot.json');

function asPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    return value;
}

export function normalizeVerifiedSnapshot(value) {
    const source = asPlainObject(value);
    if (!source || Number(source.version) !== EVENT_VERIFIED_SNAPSHOT_VERSION ||
        String(source.dedupeAlgorithmVersion || '') !== EVENT_DEDUPE_ALGORITHM_VERSION) {
        return null;
    }

    const items = Array.isArray(source.items)
        ? source.items
            .filter((item) => item && typeof item === 'object' && item.event && typeof item.event === 'object')
            .map((item) => ({
                event: item.event,
                compactSummary: String(item.compactSummary ?? '').trim(),
                ticketLink: String(item.ticketLink ?? '').trim(),
            }))
        : [];

    return {
        version: EVENT_VERIFIED_SNAPSHOT_VERSION,
        dedupeAlgorithmVersion: EVENT_DEDUPE_ALGORITHM_VERSION,
        verifiedAt: Number(source.verifiedAt ?? 0),
        reason: String(source.reason ?? '').trim(),
        sourceRevision: String(source.sourceRevision ?? '').trim(),
        rawCount: Number(source.rawCount ?? 0),
        normalizedCount: Number(source.normalizedCount ?? 0),
        canonicalCount: Number(source.canonicalCount ?? items.length),
        mergeCount: Number(source.mergeCount ?? 0),
        ambiguousCount: Number(source.ambiguousCount ?? 0),
        // Optional: old snapshots had no persisted post-dedupe invariant count.
        remainingDuplicateCount: source.remainingDuplicateCount == null ? null
            : (Number.isFinite(Number(source.remainingDuplicateCount))
                ? Math.max(0, Math.trunc(Number(source.remainingDuplicateCount))) : null),
        items,
    };
}

export function readVerifiedEventSnapshot(filePath = EVENT_VERIFIED_SNAPSHOT_FILE) {
    const absolute = resolve(filePath);
    if (!existsSync(absolute)) return null;

    try {
        return normalizeVerifiedSnapshot(JSON.parse(readFileSync(absolute, 'utf8')));
    } catch {
        return null;
    }
}

// A verified cache is the last publication boundary, not a place to infer
// missing event dates from publication timestamps, titles or descriptions.
// Refuse the entire replacement (preserving the previous disk snapshot) if
// an upstream path accidentally sends an undated/invalid canonical card.
function hasConfirmedCalendarDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(value ?? '').trim());
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const instant = new Date(Date.UTC(year, month - 1, day));
    return instant.getUTCFullYear() === year &&
        instant.getUTCMonth() + 1 === month &&
        instant.getUTCDate() === day;
}

export function writeVerifiedEventSnapshot(snapshot, filePath = EVENT_VERIFIED_SNAPSHOT_FILE) {
    const normalized = normalizeVerifiedSnapshot({
        version: EVENT_VERIFIED_SNAPSHOT_VERSION,
        dedupeAlgorithmVersion: EVENT_DEDUPE_ALGORITHM_VERSION,
        ...snapshot,
    });

    if (!normalized) {
        throw new Error('Некорректный verified-event snapshot.');
    }

    for (const [index, item] of normalized.items.entries()) {
        if (!hasConfirmedCalendarDate(item.event?.eventDate)) {
            throw new Error(`Verified-event snapshot contains an event without a confirmed calendar date at index ${index}`);
        }
    }

    const absolute = resolve(filePath);
    mkdirSync(dirname(absolute), { recursive: true });
    const temporary = `${absolute}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    renameSync(temporary, absolute);
    // Diagnostic sidecar only: a quality-audit write failure must never fail,
    // delay or roll back publication of an otherwise valid verified snapshot.
    try {
        const audit = buildEventSnapshotQualityAudit({ ...snapshot, ...normalized, items: normalized.items });
        const qualityPath = `${absolute}.quality-audit.json`;
        const qualityTemporary = `${qualityPath}.tmp-${process.pid}-${Date.now()}`;
        writeFileSync(qualityTemporary, `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
        renameSync(qualityTemporary, qualityPath);
        console.log('[EVENT SNAPSHOT QUALITY AUDIT]',
            `cards=${audit.stats.cards}`,
            `safePosters=${audit.stats.cardsWithSafePoster}`,
            `imagesWithoutMetadata=${audit.stats.imagesWithoutPathBoundMetadata}`,
            `unverifiedPosters=${audit.stats.cardsWithUnverifiedPoster}`,
            `remainingDuplicates=${audit.stats.remainingDuplicateCount ?? 'unknown'}`,
            `file=${qualityPath}`,
        );
    } catch (error) {
        console.warn('[EVENT SNAPSHOT QUALITY AUDIT WRITE ERROR]', String(error?.code || error?.name || 'unknown'));
    }
    return absolute;
}
