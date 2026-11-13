/** Build a transactional writer for one bounded page of locally recovered VK messages. */
export function createRecoveredVkMessageBatchWriter({ database, insertMessage, saveArchive } = {}) {
    if (!database || typeof database.exec !== 'function') throw new TypeError('database is required');
    if (typeof insertMessage !== 'function' || typeof saveArchive !== 'function') {
        throw new TypeError('insertMessage and saveArchive callbacks are required');
    }
    return function saveRecoveredVkMessagesBatch(messages = []) {
        const rows = Array.isArray(messages) ? messages : [];
        if (!rows.length) return 0;
        const ownsTransaction = !database.isTransaction;
        if (ownsTransaction) database.exec('BEGIN IMMEDIATE');
        try {
            let saved = 0;
            for (const row of rows) {
                const peerId = Number(row?.peerId);
                const sourcePeerId = Number(row?.sourcePeerId ?? peerId);
                const cmid = Number(row?.conversationMessageId);
                const senderId = Number(row?.senderId ?? 0);
                const createdAt = Number(row?.createdAt ?? 0);
                if (!Number.isSafeInteger(peerId) || !Number.isSafeInteger(sourcePeerId) ||
                    !Number.isSafeInteger(cmid) || cmid <= 0 || !Number.isSafeInteger(senderId) ||
                    !Number.isFinite(createdAt) || createdAt <= 0) continue;
                const entry = { ...row, peerId, sourcePeerId, conversationMessageId: cmid,
                    senderId, createdAt, text: String(row?.text ?? '') };
                insertMessage(entry);
                saveArchive(entry);
                saved += 1;
            }
            if (ownsTransaction) database.exec('COMMIT');
            return saved;
        } catch (error) {
            if (ownsTransaction) database.exec('ROLLBACK');
            throw error;
        }
    };
}
