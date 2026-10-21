/**
 * Offline/read-only quality audit of an existing verified snapshot.
 * Optional file argument allows inspection without starting the bot or SQLite.
 * Never calls VK/Telegram/AI, never edits the DB, snapshot or poster metadata.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    EVENT_VERIFIED_SNAPSHOT_FILE,
    normalizeVerifiedSnapshot,
} from '../src/features/events/eventVerifiedSnapshot.js';
import { buildEventSnapshotQualityAudit } from '../src/features/events/eventSnapshotQualityAudit.js';

const file = resolve(process.argv[2] || EVENT_VERIFIED_SNAPSHOT_FILE);
if (!existsSync(file)) {
    console.error('[EVENT SNAPSHOT AUDIT] Snapshot file not found:', file);
    process.exitCode = 2;
} else {
    try {
        const stored = JSON.parse(readFileSync(file, 'utf8'));
        const normalized = normalizeVerifiedSnapshot(stored);
        if (!normalized) throw new Error('Snapshot schema or dedupe version is outdated/invalid.');
        const report = buildEventSnapshotQualityAudit(normalized);
        console.log(JSON.stringify({ file, ...report }, null, 2));
    } catch (error) {
        console.error('[EVENT SNAPSHOT AUDIT] Cannot inspect snapshot:', String(error?.message || error));
        process.exitCode = 2;
    }
}
