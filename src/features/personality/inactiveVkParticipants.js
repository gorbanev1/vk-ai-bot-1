import { createHash } from 'node:crypto';

const DAY_SECONDS = 86400;
const cleanName = value => String(value || '').replace(/[\[\]|\r\n]/gu, ' ').replace(/\s+/gu, ' ').trim();
export function buildInactiveVkMention(userId, fullName) {
    const name = cleanName(fullName);
    if (!Number.isSafeInteger(Number(userId)) || Number(userId) <= 0 || name.split(' ').length < 2 || /^id\d+$/iu.test(name)) return '';
    return 'А где [id' + Number(userId) + '|' + name + ']?';
}
export function isVkInactivityCandidate(row, { now, inactivityDays = 14, minMessages = 16, sent = {}, memberIds = null }) {
    const id = Number(row.userId);
    const since = Math.max(Number(row.lastMessageAt || 0), Number(row.lastJoinedAt || 0));
    if (id <= 0 || Number(row.messageCount) < minMessages || !since || since > now - inactivityDays * DAY_SECONDS) return false;
    if (['left', 'kicked'].includes(row.membership)) return false;
    if (memberIds && !memberIds.has(id)) return false;
    if (Number(sent[id]?.activityAt || 0) >= since) return false;
    return Boolean(buildInactiveVkMention(id, row.fullName));
}
function localTime(now, timeZone) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(now * 1000)).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
    return { date: parts.year + '-' + parts.month + '-' + parts.day, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}
const minute = value => {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value || '')) throw new Error('Invalid inactivity schedule clock');
    const [hour, min] = value.split(':').map(Number); return hour * 60 + min;
};
const randomBetween = (min, max, random) => min + Math.floor(Math.max(0, Math.min(0.999999999, random())) * (max - min + 1));
export function planInactiveVkDay(candidates, { date, currentMinute, fromMinute, toMinute, dailyMin = 2, dailyMax = 3, minGapMinutes = 120, random = Math.random }) {
    const start = Math.max(fromMinute, currentMinute + 5);
    const availableCount = start < toMinute ? 1 + Math.floor((toMinute - 1 - start) / minGapMinutes) : 0;
    const count = Math.min(candidates.length, availableCount, randomBetween(dailyMin, dailyMax, random));
    const pool = [...candidates];
    const selected = [];
    for (let index = 0; index < count; index++) selected.push(pool.splice(randomBetween(0, pool.length - 1, random), 1)[0]);
    const slack = Math.max(0, toMinute - 1 - start - Math.max(0, count - 1) * minGapMinutes);
    const offsets = Array.from({ length: count }, () => randomBetween(0, slack, random)).sort((a, b) => a - b);
    return { date, slots: selected.map((row, index) => ({
        userId: row.userId, activityAt: Math.max(Number(row.lastMessageAt || 0), Number(row.lastJoinedAt || 0)),
        fullName: row.fullName, dueMinute: start + index * minGapMinutes + offsets[index], status: 'pending',
    })) };
}
export function inactiveVkRandomId(peerId, userId, activityAt) {
    return (createHash('sha256').update([peerId, userId, activityAt, 'where-v1'].join(':')).digest().readUInt32BE(0) & 0x7fffffff) || 1;
}

/** All decisions and send IDs survive restart; one mention per absence and no overdue burst. */
export function createInactiveVkParticipantScheduler({ loadConfig, loadState, saveState, getParticipants,
    getMemberIds = async () => null, resolveProfile, send, now = () => Math.floor(Date.now() / 1000), random = Math.random, log = () => {} }) {
    let running = false;
    return {
        async tick() {
            if (running) return { skipped: 'running' };
            running = true;
            try {
                const config = loadConfig();
                if (!config?.enabled) return { skipped: 'disabled' };
                const peerId = Number(config.peerId);
                if (!Number.isSafeInteger(peerId) || peerId < 2000000000) throw new Error('Invalid inactive VK peer');
                const timestamp = now();
                const local = localTime(timestamp, config.timeZone || 'Europe/Moscow');
                const fromMinute = minute(config.daytime?.from || '10:00');
                const toMinute = minute(config.daytime?.to || '21:00');
                if (fromMinute >= toMinute) throw new Error('Inactivity daytime window must be within one day');
                if (local.minute < fromMinute || local.minute >= toMinute) return { skipped: 'night' };
                const state = loadState(peerId) || { sent: {} };
                state.sent ||= {};
                const minGapMinutes = Math.max(60, Number(config.minGapMinutes || 120));
                const policy = { now: timestamp, sent: state.sent, minMessages: Math.max(16, Number(config.minMessages || 16)),
                    inactivityDays: Math.max(14, Number(config.inactivityDays || 14)) };
                if (state.plan?.date !== local.date) {
                    const rows = getParticipants(peerId);
                    const candidates = rows.filter(row => isVkInactivityCandidate(row, policy));
                    state.plan = planInactiveVkDay(candidates, { date: local.date, currentMinute: local.minute,
                        fromMinute, toMinute, dailyMin: 2, dailyMax: 3, minGapMinutes, random });
                    saveState(peerId, state);
                    log('planned', { peerId, candidates: candidates.length, plan: state.plan });
                }
                if (Number(state.lastSentAt || 0) + minGapMinutes * 60 > timestamp) return { skipped: 'spacing' };
                const slot = state.plan.slots.find(item => ['pending', 'sending'].includes(item.status) && item.dueMinute <= local.minute && Number(item.retryAt || 0) <= timestamp);
                if (!slot) return { planned: state.plan.slots.length, sent: 0 };
                // The roster API is optional: on access error the durable join/exit timeline is used.
                const memberIds = await getMemberIds(peerId);
                let row = getParticipants(peerId).find(item => Number(item.userId) === Number(slot.userId));
                const eligible = candidate => candidate && Math.max(Number(candidate.lastMessageAt || 0), Number(candidate.lastJoinedAt || 0)) === slot.activityAt
                    && isVkInactivityCandidate(candidate, { ...policy, memberIds, now: now() });
                if (!eligible(row)) {
                    slot.status = 'cancelled'; saveState(peerId, state); log('cancelled', { peerId, userId: slot.userId });
                    return { cancelled: 1 };
                }
                const profile = await resolveProfile(row.userId, row.fullName);
                if (profile?.deactivated || !buildInactiveVkMention(row.userId, profile?.fullName)) {
                    slot.status = 'cancelled'; saveState(peerId, state); return { cancelled: 1 };
                }
                // A message/exit can arrive while profiles are loading. Recheck before sending.
                row = getParticipants(peerId).find(item => Number(item.userId) === Number(slot.userId));
                const finalTime = localTime(now(), config.timeZone || 'Europe/Moscow');
                if (!eligible(row)) { slot.status = 'cancelled'; saveState(peerId, state); return { cancelled: 1 }; }
                if (finalTime.date !== local.date || finalTime.minute < fromMinute || finalTime.minute >= toMinute) return { skipped: 'night' };
                const message = buildInactiveVkMention(row.userId, profile.fullName);
                slot.status = 'sending'; slot.randomId ||= inactiveVkRandomId(peerId, row.userId, slot.activityAt);
                saveState(peerId, state);
                try {
                    await send({ peer_id: peerId, random_id: slot.randomId, message });
                } catch (error) {
                    slot.status = 'pending'; slot.retryAt = now() + 30 * 60; saveState(peerId, state); throw error;
                }
                slot.status = 'sent'; slot.sentAt = now(); slot.fullName = profile.fullName;
                state.sent[row.userId] = { activityAt: slot.activityAt, sentAt: slot.sentAt };
                state.lastSentAt = slot.sentAt;
                saveState(peerId, state);
                log('sent', { peerId, userId: row.userId, fullName: profile.fullName, message });
                return { sent: 1 };
            } finally { running = false; }
        },
    };
}
