/**
 * Durable auto-summary state.
 *
 * This database intentionally lives OUTSIDE the bot installation directory by
 * default. Replacing/unpacking a full bot release therefore cannot reset the
 * enabled mode, next scheduled run, or completed-slot history.
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const AUTO_SUMMARY_STATE_DB_FILENAME = 'auto-summary.sqlite';

export function resolveAutoSummaryStateDirectory({
    env = process.env,
    platform = process.platform,
    homeDirectory = homedir(),
} = {}) {
    const explicit = String(env?.GIGORAVE_STATE_DIR ?? '').trim();
    if (explicit) return resolve(explicit);

    if (platform === 'win32') {
        const windowsBase = String(
            env?.LOCALAPPDATA || env?.APPDATA || join(homeDirectory, 'AppData', 'Local'),
        ).trim();
        return join(windowsBase, 'Gigorave', 'state');
    }

    const xdgStateHome = String(env?.XDG_STATE_HOME ?? '').trim();
    if (xdgStateHome) return join(resolve(xdgStateHome), 'gigorave');

    return join(homeDirectory, '.local', 'state', 'gigorave');
}

function mapSettings(row) {
    if (!row) return null;
    let schedule = [];
    try {
        const parsed = JSON.parse(String(row.schedule_json || '[]'));
        schedule = Array.isArray(parsed) ? parsed.map((item) => String(item || '').trim()).filter(Boolean) : [];
    } catch {
        schedule = [];
    }
    return {
        peerId: Number(row.peer_id),
        platform: String(row.platform || 'vk'),
        endpointKey: String(row.endpoint_key || (row.platform === 'telegram' ? 'telegram' : 'vk:primary')),
        externalPeerId: String(row.external_peer_id || ''),
        mode: String(row.mode || 'full'),
        ...(schedule.length ? { schedule } : {}),
        enabled: Boolean(row.enabled),
        nextRunAt: Number(row.next_run_at || 0),
        updatedBy: Number(row.updated_by || 0),
        updatedAt: Number(row.updated_at || 0),
    };
}

function mapRun(row) {
    if (!row) return null;
    return {
        peerId: Number(row.peer_id),
        summaryDate: String(row.summary_date),
        slotLabel: String(row.slot_label),
        scheduledAt: Number(row.scheduled_at || 0),
        startedAt: Number(row.started_at || 0),
        finishedAt: Number(row.finished_at || 0),
        messageCount: Number(row.message_count || 0),
        summaryText: String(row.summary_text || ''),
    };
}

export function createAutoSummaryStateStore({
    directory = resolveAutoSummaryStateDirectory(),
    databasePath = '',
} = {}) {
    const path = databasePath
        ? resolve(String(databasePath))
        : join(resolve(String(directory)), AUTO_SUMMARY_STATE_DB_FILENAME);

    mkdirSync(dirname(path), { recursive: true });

    const db = new DatabaseSync(path);
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA busy_timeout = 5000;

        CREATE TABLE IF NOT EXISTS auto_summary_settings (
            peer_id INTEGER PRIMARY KEY,
            platform TEXT NOT NULL DEFAULT 'vk',
            endpoint_key TEXT NOT NULL DEFAULT 'vk:primary',
            external_peer_id TEXT NOT NULL DEFAULT '',
            mode TEXT NOT NULL DEFAULT 'full' CHECK (mode IN ('full', 'day', 'evening')),
            enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
            next_run_at INTEGER NOT NULL DEFAULT 0,
            updated_by INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS auto_summary_settings_due_idx
        ON auto_summary_settings (enabled, next_run_at);

        CREATE TABLE IF NOT EXISTS auto_summary_runs (
            peer_id INTEGER NOT NULL,
            summary_date TEXT NOT NULL,
            slot_label TEXT NOT NULL,
            scheduled_at INTEGER NOT NULL,
            started_at INTEGER NOT NULL,
            finished_at INTEGER NOT NULL DEFAULT 0,
            message_count INTEGER NOT NULL DEFAULT 0,
            summary_text TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (peer_id, summary_date, slot_label)
        );

        CREATE INDEX IF NOT EXISTS auto_summary_runs_peer_idx
        ON auto_summary_runs (peer_id, scheduled_at DESC);

        CREATE TABLE IF NOT EXISTS auto_summary_state_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS auto_summary_health (
            peer_id INTEGER PRIMARY KEY,
            last_attempt_at INTEGER NOT NULL DEFAULT 0,
            last_success_at INTEGER NOT NULL DEFAULT 0,
            last_error TEXT NOT NULL DEFAULT '',
            consecutive_failures INTEGER NOT NULL DEFAULT 0
        );
    `);

    const settingsColumns = new Set(
        db.prepare('PRAGMA table_info(auto_summary_settings)').all().map((row) => String(row.name)),
    );
    if (!settingsColumns.has('schedule_json')) {
        db.exec("ALTER TABLE auto_summary_settings ADD COLUMN schedule_json TEXT NOT NULL DEFAULT '[]'");
    }

    const getSettingsStatement = db.prepare(`
        SELECT peer_id, platform, endpoint_key, external_peer_id, mode, schedule_json, enabled,
               next_run_at, updated_by, updated_at
        FROM auto_summary_settings
        WHERE peer_id = ?
    `);
    const upsertSettingsStatement = db.prepare(`
        INSERT INTO auto_summary_settings (
            peer_id, platform, endpoint_key, external_peer_id, mode, schedule_json, enabled,
            next_run_at, updated_by, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(peer_id) DO UPDATE SET
            platform = excluded.platform,
            endpoint_key = excluded.endpoint_key,
            external_peer_id = excluded.external_peer_id,
            mode = excluded.mode,
            schedule_json = excluded.schedule_json,
            enabled = excluded.enabled,
            next_run_at = excluded.next_run_at,
            updated_by = excluded.updated_by,
            updated_at = excluded.updated_at
    `);
    const dueSettingsStatement = db.prepare(`
        SELECT peer_id, platform, endpoint_key, external_peer_id, mode, schedule_json, enabled,
               next_run_at, updated_by, updated_at
        FROM auto_summary_settings
        WHERE enabled = 1
          AND next_run_at > 0
          AND next_run_at <= ?
        ORDER BY next_run_at ASC, peer_id ASC
    `);
    const enabledSettingsStatement = db.prepare(`
        SELECT peer_id, platform, endpoint_key, external_peer_id, mode, schedule_json, enabled,
               next_run_at, updated_by, updated_at
        FROM auto_summary_settings
        WHERE enabled = 1
        ORDER BY peer_id ASC
    `);
    const allSettingsStatement = db.prepare(`
        SELECT peer_id, platform, endpoint_key, external_peer_id, mode, schedule_json, enabled,
               next_run_at, updated_by, updated_at
        FROM auto_summary_settings
        ORDER BY platform ASC, external_peer_id ASC, peer_id ASC
    `);
    const getRunStatement = db.prepare(`
        SELECT peer_id, summary_date, slot_label, scheduled_at, started_at,
               finished_at, message_count, summary_text
        FROM auto_summary_runs
        WHERE peer_id = ? AND summary_date = ? AND slot_label = ?
    `);
    const upsertRunStatement = db.prepare(`
        INSERT INTO auto_summary_runs (
            peer_id, summary_date, slot_label, scheduled_at, started_at,
            finished_at, message_count, summary_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(peer_id, summary_date, slot_label) DO UPDATE SET
            scheduled_at = excluded.scheduled_at,
            started_at = excluded.started_at,
            finished_at = excluded.finished_at,
            message_count = excluded.message_count,
            summary_text = excluded.summary_text
    `);
    const importSettingsStatement = db.prepare(`
        INSERT INTO auto_summary_settings (
            peer_id, platform, endpoint_key, external_peer_id, mode, schedule_json, enabled,
            next_run_at, updated_by, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(peer_id) DO UPDATE SET
            platform = excluded.platform,
            endpoint_key = excluded.endpoint_key,
            external_peer_id = excluded.external_peer_id,
            mode = excluded.mode,
            schedule_json = excluded.schedule_json,
            enabled = excluded.enabled,
            next_run_at = excluded.next_run_at,
            updated_by = excluded.updated_by,
            updated_at = excluded.updated_at
        WHERE excluded.updated_at > auto_summary_settings.updated_at
    `);
    const importRunStatement = db.prepare(`
        INSERT INTO auto_summary_runs (
            peer_id, summary_date, slot_label, scheduled_at, started_at,
            finished_at, message_count, summary_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(peer_id, summary_date, slot_label) DO UPDATE SET
            scheduled_at = excluded.scheduled_at,
            started_at = excluded.started_at,
            finished_at = excluded.finished_at,
            message_count = excluded.message_count,
            summary_text = excluded.summary_text
        WHERE excluded.finished_at > auto_summary_runs.finished_at
           OR (auto_summary_runs.finished_at = 0 AND excluded.started_at > auto_summary_runs.started_at)
    `);

    const getHealthStatement = db.prepare(`
        SELECT peer_id, last_attempt_at, last_success_at, last_error, consecutive_failures
        FROM auto_summary_health
        WHERE peer_id = ?
    `);
    const upsertHealthStatement = db.prepare(`
        INSERT INTO auto_summary_health (
            peer_id, last_attempt_at, last_success_at, last_error, consecutive_failures
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(peer_id) DO UPDATE SET
            last_attempt_at = excluded.last_attempt_at,
            last_success_at = excluded.last_success_at,
            last_error = excluded.last_error,
            consecutive_failures = excluded.consecutive_failures
    `);

    function getSettings(peerId) {
        return mapSettings(getSettingsStatement.get(Number(peerId)));
    }

    function saveSettings({
        peerId,
        platform = 'vk',
        endpointKey = 'vk:primary',
        externalPeerId = '',
        mode = 'full',
        schedule = [],
        enabled = true,
        nextRunAt = 0,
        updatedBy = 0,
        updatedAt = Math.floor(Date.now() / 1000),
    }) {
        upsertSettingsStatement.run(
            Number(peerId),
            String(platform || 'vk'),
            String(endpointKey || (platform === 'telegram' ? 'telegram' : 'vk:primary')),
            String(externalPeerId || ''),
            String(mode || 'full'),
            JSON.stringify(Array.isArray(schedule) ? schedule : []),
            enabled ? 1 : 0,
            Number(nextRunAt) || 0,
            Number(updatedBy) || 0,
            Number(updatedAt) || Math.floor(Date.now() / 1000),
        );
        return getSettings(peerId);
    }

    function getDueSettings(nowTimestamp = Math.floor(Date.now() / 1000)) {
        return dueSettingsStatement.all(Number(nowTimestamp)).map(mapSettings);
    }

    function getEnabledSettings() {
        return enabledSettingsStatement.all().map(mapSettings);
    }

    function getAllSettings() {
        return allSettingsStatement.all().map(mapSettings);
    }

    function getRun(peerId, summaryDate, slotLabel) {
        return mapRun(getRunStatement.get(
            Number(peerId),
            String(summaryDate),
            String(slotLabel),
        ));
    }

    function saveRun({
        peerId,
        summaryDate,
        slotLabel,
        scheduledAt,
        startedAt,
        finishedAt = 0,
        messageCount = 0,
        summaryText = '',
    }) {
        upsertRunStatement.run(
            Number(peerId),
            String(summaryDate),
            String(slotLabel),
            Number(scheduledAt) || 0,
            Number(startedAt) || 0,
            Number(finishedAt) || 0,
            Number(messageCount) || 0,
            String(summaryText || ''),
        );
        return getRun(peerId, summaryDate, slotLabel);
    }

    function getHealth(peerId) {
        const row = getHealthStatement.get(Number(peerId));
        if (!row) {
            return {
                peerId: Number(peerId),
                lastAttemptAt: 0,
                lastSuccessAt: 0,
                lastError: '',
                consecutiveFailures: 0,
            };
        }
        return {
            peerId: Number(row.peer_id),
            lastAttemptAt: Number(row.last_attempt_at || 0),
            lastSuccessAt: Number(row.last_success_at || 0),
            lastError: String(row.last_error || ''),
            consecutiveFailures: Number(row.consecutive_failures || 0),
        };
    }

    function saveHealth({
        peerId,
        lastAttemptAt = 0,
        lastSuccessAt = 0,
        lastError = '',
        consecutiveFailures = 0,
    }) {
        upsertHealthStatement.run(
            Number(peerId),
            Number(lastAttemptAt) || 0,
            Number(lastSuccessAt) || 0,
            String(lastError || '').slice(0, 2000),
            Math.max(0, Number(consecutiveFailures) || 0),
        );
        return getHealth(peerId);
    }

    function importLegacy({ settings = [], runs = [] } = {}) {
        let settingsImported = 0;
        let runsImported = 0;
        db.exec('BEGIN IMMEDIATE');
        try {
            for (const row of settings) {
                const result = importSettingsStatement.run(
                    Number(row?.peer_id ?? row?.peerId),
                    String(row?.platform || 'vk'),
                    String(row?.endpoint_key ?? row?.endpointKey ?? 'vk:primary'),
                    String(row?.external_peer_id ?? row?.externalPeerId ?? ''),
                    String(row?.mode || 'full'),
                    JSON.stringify(Array.isArray(row?.schedule) ? row.schedule : []),
                    Number(row?.enabled ? 1 : 0),
                    Number(row?.next_run_at ?? row?.nextRunAt ?? 0) || 0,
                    Number(row?.updated_by ?? row?.updatedBy ?? 0) || 0,
                    Number(row?.updated_at ?? row?.updatedAt ?? 0) || 0,
                );
                settingsImported += Number(result?.changes || 0);
            }
            for (const row of runs) {
                const result = importRunStatement.run(
                    Number(row?.peer_id ?? row?.peerId),
                    String(row?.summary_date ?? row?.summaryDate ?? ''),
                    String(row?.slot_label ?? row?.slotLabel ?? ''),
                    Number(row?.scheduled_at ?? row?.scheduledAt ?? 0) || 0,
                    Number(row?.started_at ?? row?.startedAt ?? 0) || 0,
                    Number(row?.finished_at ?? row?.finishedAt ?? 0) || 0,
                    Number(row?.message_count ?? row?.messageCount ?? 0) || 0,
                    String(row?.summary_text ?? row?.summaryText ?? ''),
                );
                runsImported += Number(result?.changes || 0);
            }
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
        return { settingsImported, runsImported };
    }

    return {
        databasePath: path,
        getSettings,
        saveSettings,
        getDueSettings,
        getEnabledSettings,
        getAllSettings,
        getRun,
        saveRun,
        getHealth,
        saveHealth,
        importLegacy,
        close() {
            db.close();
        },
    };
}
