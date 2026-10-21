/** Persistent polling state and request history, scoped to the VK connection/chat. */
export function createVoiceTranscriptJobStore(database) {
    database.exec(`
        CREATE TABLE IF NOT EXISTS vk_voice_transcript_jobs (
            job_key TEXT PRIMARY KEY, group_id INTEGER NOT NULL, peer_id INTEGER NOT NULL,
            cmid INTEGER NOT NULL, received_at INTEGER NOT NULL, next_at INTEGER NOT NULL,
            status TEXT NOT NULL, data_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS vk_voice_transcript_jobs_due
        ON vk_voice_transcript_jobs(status, next_at);
        CREATE INDEX IF NOT EXISTS vk_voice_transcript_jobs_recent
        ON vk_voice_transcript_jobs(group_id, peer_id, received_at DESC);
    `);
    const decode = row => row ? JSON.parse(row.data_json) : null;
    const put = database.prepare(`INSERT INTO vk_voice_transcript_jobs
        (job_key, group_id, peer_id, cmid, received_at, next_at, status, data_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_key) DO UPDATE SET next_at=excluded.next_at,
            status=excluded.status, data_json=excluded.data_json`);
    return {
        get: key => decode(database.prepare('SELECT data_json FROM vk_voice_transcript_jobs WHERE job_key=?').get(key)),
        save(job) {
            put.run(job.key, job.groupId, job.peerId, job.cmid, job.receivedAt,
                job.nextAt || 0, job.status, JSON.stringify(job));
            return job;
        },
        due(now) {
            return database.prepare(`SELECT data_json FROM vk_voice_transcript_jobs
                WHERE status IN ('pending', 'ready') AND next_at <= ? ORDER BY next_at LIMIT 100`)
                .all(now).map(decode);
        },
        recent({ groupId, peerId, cmid = 0, limit = 5 }) {
            return database.prepare(`SELECT data_json FROM vk_voice_transcript_jobs
                WHERE group_id=? AND peer_id=? AND (?=0 OR cmid=?)
                ORDER BY received_at DESC LIMIT ?`)
                .all(groupId, peerId, cmid, cmid, Math.min(20, Math.max(1, limit))).map(decode);
        },
    };
}
