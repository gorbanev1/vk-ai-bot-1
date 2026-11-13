import { DatabaseSync } from 'node:sqlite';
import { assertTestDatabaseIsolation, resolveMainDatabasePath } from '../../infrastructure/database/runtimePaths.js';

export function createImageRecoveryAudit({ databasePath = resolveMainDatabasePath() } = {}) {
    const run = (fn) => {
        assertTestDatabaseIsolation({ databasePath });
        const db = new DatabaseSync(databasePath);
        try {
            db.exec('PRAGMA busy_timeout=500');
            db.exec(`CREATE TABLE IF NOT EXISTS image_generation_recovery (
                id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, status TEXT NOT NULL,
                notification TEXT NOT NULL, payload_json TEXT NOT NULL)`);
            return fn(db);
        } finally { db.close(); }
    };
    return {
        save(record) { return run(db => db.prepare(`INSERT INTO image_generation_recovery VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET status=excluded.status, notification=excluded.notification, payload_json=excluded.payload_json`)
            .run(record.id, record.createdAt, record.status, record.notification || 'not-ready', JSON.stringify(record))); },
        pending() { return run(db => db.prepare("SELECT payload_json FROM image_generation_recovery WHERE notification='pending' ORDER BY created_at LIMIT 10").all().map(r => JSON.parse(r.payload_json))); },
    };
}
