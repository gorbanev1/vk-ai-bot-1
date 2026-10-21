/** Activity includes text, voices and other attachments, but never service actions/outbox. */
export function createVkInactivityQueries(database) {
    const query = database.prepare(
        "WITH activity AS (" +
        " SELECT sender_id AS user_id, created_at FROM vk_message_archive" +
        " WHERE peer_id=:peer AND sender_id>0 AND is_outbox=0 AND action_type=''" +
        " UNION ALL SELECT m.sender_id AS user_id, m.created_at FROM messages m" +
        " WHERE m.peer_id=:peer AND m.sender_id>0 AND NOT EXISTS (" +
        " SELECT 1 FROM vk_message_archive a WHERE a.peer_id=m.peer_id" +
        " AND a.conversation_message_id=m.conversation_message_id AND a.sender_id=m.sender_id)" +
        "), totals AS (SELECT user_id, COUNT(*) AS messageCount, MAX(created_at) AS lastMessageAt" +
        " FROM activity GROUP BY user_id)" +
        " SELECT t.user_id AS userId, t.messageCount, t.lastMessageAt, n.full_name AS fullName," +
        " (SELECT event_type FROM chat_membership_events e WHERE e.platform='vk'" +
        " AND e.peer_id=:peer AND e.member_id=t.user_id" +
        " ORDER BY e.created_at DESC, e.conversation_message_id DESC, e.event_type DESC LIMIT 1) AS membership," +
        " (SELECT MAX(created_at) FROM chat_membership_events e WHERE e.platform='vk'" +
        " AND e.peer_id=:peer AND e.member_id=t.user_id AND e.event_type='joined') AS lastJoinedAt" +
        " FROM totals t LEFT JOIN vk_user_name_cache n ON n.user_id=t.user_id"
    );
    return {
        participants(peerId) { return query.all({ peer: Number(peerId) }); },
    };
}
