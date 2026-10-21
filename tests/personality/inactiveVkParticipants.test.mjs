import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createVkInactivityQueries } from '../../src/infrastructure/database/vkInactivityQueries.js';
import { buildInactiveVkMention, isVkInactivityCandidate, planInactiveVkDay,
    createInactiveVkParticipantScheduler } from '../../src/features/personality/inactiveVkParticipants.js';
const DAY = 86400;
const start = Date.parse('2026-10-15T10:00:00+03:00') / 1000;
const row = (userId = 1, fields = {}) => ({ userId, fullName: 'Тимасин Тимасинский',
    messageCount: 16, lastMessageAt: start - 14 * DAY, membership: null, ...fields });

test('full name is the visible VK mention label, with exact requested phrase', () => {
    assert.equal(buildInactiveVkMention(42, 'Тимасин Тимасинский'), 'А где [id42|Тимасин Тимасинский]?');
    assert.equal(buildInactiveVkMention(42, 'id42'), '');
    assert.equal(buildInactiveVkMention(42, ''), '');
    assert.equal(buildInactiveVkMention(42, '[Имя|\nФамилия]'), 'А где [id42|Имя Фамилия]?');
});
test('16 messages and 14 full days required; exit, rejoin and same absence excluded', () => {
    const policy = { now: start };
    assert.equal(isVkInactivityCandidate(row(), policy), true);
    assert.equal(isVkInactivityCandidate(row(1, { messageCount: 15 }), policy), false);
    assert.equal(isVkInactivityCandidate(row(1, { lastMessageAt: start - 14 * DAY + 1 }), policy), false);
    for (const membership of ['left', 'kicked']) assert.equal(isVkInactivityCandidate(row(1, { membership }), policy), false);
    assert.equal(isVkInactivityCandidate(row(1, { membership: 'joined', lastJoinedAt: start - DAY }), policy), false);
    assert.equal(isVkInactivityCandidate(row(), { ...policy, sent: { 1: { activityAt: row().lastMessageAt } } }), false);
    assert.equal(isVkInactivityCandidate(row(), { ...policy, memberIds: new Set([2]) }), false);
    assert.equal(isVkInactivityCandidate(row(), { ...policy, memberIds: new Set([1]) }), true);
});
test('daily plan picks 2–3 distinct people with at least two-hour spacing and no night slots', () => {
    const people = [1, 2, 3, 4, 5].map(id => row(id));
    for (const random of [() => 0, () => 0.999, Math.random]) {
        for (let iteration = 0; iteration < 30; iteration++) {
            const p = planInactiveVkDay(people, { date: '2026-10-15', currentMinute: 600, fromMinute: 600, toMinute: 1260, random });
            assert.ok(p.slots.length >= 2 && p.slots.length <= 3);
            assert.equal(new Set(p.slots.map(x => x.userId)).size, p.slots.length);
            p.slots.forEach((slot, i) => {
                assert.ok(slot.dueMinute >= 605 && slot.dueMinute < 1260);
                if (i) assert.ok(slot.dueMinute - p.slots[i - 1].dueMinute >= 120);
            });
        }
    }
});
function harness({ sendImpl, profileImpl, memberIds = null } = {}) {
    let timestamp = start;
    let state = null;
    const people = [1, 2, 3, 4].map(id => row(id));
    const sent = [];
    const options = {
        loadConfig: () => ({ enabled: true, peerId: 2000000006 }), now: () => timestamp, random: () => 0,
        loadState: () => state && structuredClone(state), saveState: (_peer, value) => { state = structuredClone(value); },
        getParticipants: () => people, getMemberIds: async () => memberIds,
        resolveProfile: profileImpl || (async () => ({ fullName: 'Тимасин Тимасинский' })),
        send: async params => { sent.push(params); if (sendImpl) await sendImpl(params); },
    };
    let worker = createInactiveVkParticipantScheduler(options);
    return { tick: () => worker.tick(), restart: () => { worker = createInactiveVkParticipantScheduler(options); },
        setTime: time => { timestamp = time; }, state: () => state, people, sent };
}

test('restart preserves schedule; never burst overdue messages; once per absence', async () => {
    const h = harness(); await h.tick();
    assert.equal(h.sent.length, 0);
    assert.equal(h.state().plan.slots.length, 2);
    h.restart(); h.setTime(start + 6 * 3600); await h.tick(); await h.tick();
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].peer_id, 2000000006);
    assert.equal(h.sent[0].message, 'А где [id1|Тимасин Тимасинский]?');
    h.setTime(start + 8 * 3600); await h.tick();
    assert.equal(h.sent.length, 2);
    h.setTime(start + 11 * 3600); assert.equal((await h.tick()).skipped, 'night');
    h.setTime(start + DAY); await h.tick();
    assert.deepEqual(h.state().plan.slots.map(x => x.userId), [3, 4]);
});

test('new message or exit after planning cancels mention, including during API lookup', async () => {
    const h = harness(); await h.tick();
    h.people[0].lastMessageAt = start;
    h.setTime(start + 5 * 60); await h.tick();
    assert.equal(h.sent.length, 0); assert.equal(h.state().plan.slots[0].status, 'cancelled');
    h.people[1].membership = 'left'; h.setTime(start + 3 * 3600); await h.tick();
    assert.equal(h.sent.length, 0);
    const race = harness({ profileImpl: async () => { race.people[0].membership = 'kicked'; return { fullName: 'Новое Имя' }; } });
    await race.tick(); race.setTime(start + 5 * 60); await race.tick();
    assert.equal(race.sent.length, 0);
});
test('fresh complete roster can exclude a member missing an exit event', async () => {
    const h = harness({ memberIds: new Set([2, 3, 4]) });
    await h.tick(); h.setTime(start + 5 * 60); await h.tick();
    assert.equal(h.sent.length, 0); assert.equal(h.state().plan.slots[0].status, 'cancelled');
});
test('failed send reuses random_id on retry, including after restart', async () => {
    let failed = false;
    const h = harness({ sendImpl: async () => { if (!failed) { failed = true; throw Error('timeout'); } } });
    await h.tick(); h.setTime(start + 5 * 60);
    await assert.rejects(h.tick());
    h.restart(); h.setTime(start + 35 * 60); await h.tick();
    assert.equal(h.sent.length, 2);
    assert.equal(h.sent[0].random_id, h.sent[1].random_id);
    assert.equal(h.state().plan.slots[0].status, 'sent');
});
test('overlapping ticks cannot send same mention twice', async () => {
    let release;
    const h = harness({ sendImpl: () => new Promise(resolve => { release = resolve; }) });
    await h.tick(); h.setTime(start + 5 * 60);
    const first = h.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await h.tick()).skipped, 'running');
    release(); await first;
    assert.equal(h.sent.length, 1);
});
test('SQLite counts actual messages once across stores, includes empty attachment messages and excludes service/outbox', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE vk_message_archive(peer_id,sender_id,created_at,is_outbox,action_type,conversation_message_id);' +
        'CREATE TABLE messages(peer_id,sender_id,created_at,conversation_message_id);' +
        'CREATE TABLE chat_membership_events(platform,peer_id,member_id,event_type,created_at,conversation_message_id);' +
        'CREATE TABLE vk_user_name_cache(user_id,full_name);');
    const archive = db.prepare('INSERT INTO vk_message_archive VALUES (?,?,?,?,?,?)');
    archive.run(6, 1, 100, 0, '', 1);
    archive.run(6, 1, 200, 0, '', 2);
    archive.run(6, 1, 600, 0, 'chat_kick_user', 3);
    archive.run(6, 1, 700, 1, '', 4);
    archive.run(3, 1, 800, 0, '', 1);
    db.exec("INSERT INTO messages VALUES (6,1,100,1),(6,1,300,5),(6,1,600,3),(6,1,700,4);" +
        "INSERT INTO chat_membership_events VALUES ('vk',6,1,'left',250,5),('vk',6,1,'joined',260,6);" +
        "INSERT INTO vk_user_name_cache VALUES (1,'Имя Фамилия');");
    const result = createVkInactivityQueries(db).participants(6);
    assert.equal(result.length, 1); assert.equal(result[0].messageCount, 3);
    assert.equal(result[0].lastMessageAt, 300); assert.equal(result[0].membership, 'joined');
    assert.equal(result[0].lastJoinedAt, 260); assert.equal(result[0].fullName, 'Имя Фамилия');
    db.close();
});
