const POLICY_VERSION = 1;
export const ACTIVE_COMMUNICATION_POLICY_PEER_ID = 2000000011;
export const ACTIVE_COMMUNICATION_POLICY_WINDOW_SECONDS = 180;
export const ACTIVE_COMMUNICATION_POLICY_MAX_INITIATIVES = 2;
export const ACTIVE_COMMUNICATION_POLICY_HISTORY_LIMIT = 10;

const STOP_WORDS = new Set([
    'это', 'этот', 'эта', 'как', 'так', 'что', 'чтобы', 'если', 'уже', 'еще', 'ещё',
    'только', 'просто', 'меня', 'тебя', 'него', 'него', 'они', 'она', 'они', 'можно',
    'будет', 'быть', 'было', 'были', 'тут', 'там', 'вот', 'весь', 'все', 'всё', 'очень',
]);
const TOPIC_GROUPS = [
    ['свадьб', 'женитьб', 'замужеств', 'брак', 'сватовств'],
];

export function isActiveCommunicationPolicyPeer(peerId) {
    return Number(peerId) === ACTIVE_COMMUNICATION_POLICY_PEER_ID;
}

export function normalizeInitiativeText(value) {
    return String(value ?? '')
        .toLocaleLowerCase('ru-RU')
        .replace(/ё/gu, 'е')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 500);
}

export function initiativeTopicKey(value) {
    const words = normalizeInitiativeText(value)
        .split(' ')
        .filter((word) => word.length >= 4 && !STOP_WORDS.has(word));
    const grouped = words.map((word) => {
        const group = TOPIC_GROUPS.find((roots) => roots.some((root) => word.startsWith(root)));
        return group ? group[0] : word;
    });
    return [...new Set(grouped)].sort().slice(0, 6).join('|');
}

export function createActiveCommunicationPolicyState(value = {}) {
    const now = Math.floor(Date.now() / 1000);
    const state = value && typeof value === 'object' ? value : {};
    return {
        version: POLICY_VERSION,
        timestamps: Array.isArray(state.timestamps)
            ? state.timestamps.map(Number).filter(Number.isFinite)
            : [],
        history: Array.isArray(state.history)
            ? state.history.filter((item) => item && typeof item === 'object').slice(-ACTIVE_COMMUNICATION_POLICY_HISTORY_LIMIT)
            : [],
        optOut: state.optOut && typeof state.optOut === 'object' ? { ...state.optOut } : {},
        updatedAt: Number(state.updatedAt) || now,
    };
}

function pruneState(state, nowSec) {
    state.timestamps = state.timestamps.filter((timestamp) =>
        nowSec - timestamp < ACTIVE_COMMUNICATION_POLICY_WINDOW_SECONDS);
    state.history = state.history.filter((item) =>
        nowSec - Number(item.timestamp || 0) < 24 * 60 * 60);
    return state;
}

export function reserveActiveInitiative({
    peerId,
    nowSec = Math.floor(Date.now() / 1000),
    getState,
    setState,
    reservations,
} = {}) {
    if (!isActiveCommunicationPolicyPeer(peerId)) return { allowed: true, token: null };
    const state = pruneState(createActiveCommunicationPolicyState(getState?.() || {}), nowSec);
    if (state.timestamps.length >= ACTIVE_COMMUNICATION_POLICY_MAX_INITIATIVES) {
        setState?.({ ...state, updatedAt: nowSec });
        return { allowed: false, reason: 'window-limit' };
    }
    const token = `${Number(peerId)}:${nowSec}:${Math.random().toString(36).slice(2, 10)}`;
    state.timestamps.push(nowSec);
    state.updatedAt = nowSec;
    setState?.(state);
    reservations?.set(token, { peerId: Number(peerId), timestamp: nowSec });
    return { allowed: true, token, timestamp: nowSec };
}

export function releaseActiveInitiative({ token, getState, setState, reservations } = {}) {
    const reservation = reservations?.get(token);
    if (!reservation) return;
    reservations.delete(token);
    const state = createActiveCommunicationPolicyState(getState?.() || {});
    const index = state.timestamps.lastIndexOf(reservation.timestamp);
    if (index >= 0) state.timestamps.splice(index, 1);
    setState?.({ ...state, updatedAt: Math.floor(Date.now() / 1000) });
}

export function recordActiveInitiative({
    peerId,
    token,
    text,
    sourceText = '',
    targetUserId = 0,
    getState,
    setState,
    reservations,
    nowSec = Math.floor(Date.now() / 1000),
} = {}) {
    if (!isActiveCommunicationPolicyPeer(peerId)) return;
    if (token) reservations?.delete(token);
    const state = pruneState(createActiveCommunicationPolicyState(getState?.() || {}), nowSec);
    state.history.push({
        text: String(text ?? '').trim().slice(0, 900),
        sourceText: String(sourceText ?? '').trim().slice(0, 500),
        topic: initiativeTopicKey(text || sourceText),
        targetUserId: Number(targetUserId) || 0,
        timestamp: nowSec,
    });
    state.history = state.history.slice(-ACTIVE_COMMUNICATION_POLICY_HISTORY_LIMIT);
    state.updatedAt = nowSec;
    setState?.(state);
}

export function shouldAllowInitiativeText({
    peerId,
    text,
    sourceText = '',
    direct = false,
    getState,
    random = Math.random,
    nowSec = Math.floor(Date.now() / 1000),
} = {}) {
    if (direct || !isActiveCommunicationPolicyPeer(peerId)) return { allowed: true };
    const state = pruneState(createActiveCommunicationPolicyState(getState?.() || {}), nowSec);
    const normalized = normalizeInitiativeText(text);
    if (!normalized) return { allowed: false, reason: 'empty' };
    if (state.history.some((item) => normalizeInitiativeText(item.text) === normalized)) {
        return { allowed: false, reason: 'literal-repeat' };
    }
    const topic = initiativeTopicKey(text || sourceText);
    if (!topic) return { allowed: true };
    const sameTopic = state.history.filter((item) => item.topic && item.topic === topic);
    if (sameTopic.length >= 2) return { allowed: false, reason: 'topic-repeat' };
    if (sameTopic.length === 1 && Number(random?.() ?? 0.5) >= 0.5) {
        return { allowed: false, reason: 'topic-cooldown' };
    }
    return { allowed: true };
}

function isReplyToDifferentUser(replyMessage, senderId, botIds = []) {
    if (!replyMessage || typeof replyMessage !== 'object') return false;
    const fromId = Number(replyMessage.from_id ?? replyMessage.fromId ?? 0);
    const botSet = new Set((Array.isArray(botIds) ? botIds : [botIds]).map(Number));
    return fromId !== 0 && fromId !== Number(senderId) && !botSet.has(fromId);
}

function isReplyToBot(replyMessage, botIds = []) {
    if (!replyMessage || typeof replyMessage !== 'object') return false;
    const fromId = Number(replyMessage.from_id ?? replyMessage.fromId ?? 0);
    const botSet = new Set((Array.isArray(botIds) ? botIds : [botIds]).map(Number));
    return fromId !== 0 && botSet.has(fromId);
}

export function detectActiveCommunicationOptOut(text, {
    directedAtBot = false,
    replyMessage = null,
    senderId = 0,
    botIds = [],
} = {}) {
    const value = String(text ?? '').trim();
    const stop = /(?:^|[\s,.:!?-])(?:отстань|отъебись|не\s+трогай\s+меня|хватит(?:\s+меня)?\s+(?:подкалывать|стебать|доставать)|прекрати(?:\s+(?:меня\s+)?(?:подкалывать|стебать|доставать))?)(?:$|[\s,.:!?-])/iu.test(value);
    if (!stop) return { matched: false };
    if (!directedAtBot) {
        if (isReplyToDifferentUser(replyMessage, senderId, botIds)) {
            return { matched: false, reason: 'reply-to-other-user' };
        }
        if (replyMessage && !isReplyToBot(replyMessage, botIds)) {
            return { matched: false, reason: 'not-directed-at-bot' };
        }
    }
    const withoutMention = value
        .replace(/^(?:гигорейв|gigorave)[\s,.:!?-]*/iu, '')
        .replace(/[\s,.:!?-]+$/gu, '')
        .trim();
    const standalone = /^(?:отстань|отъебись|не\s+трогай\s+меня|хватит(?:\s+меня)?\s+(?:подкалывать|стебать|доставать)|прекрати(?:\s+(?:меня\s+)?(?:подкалывать|стебать|доставать))?)$/iu.test(withoutMention);
    return { matched: true, standalone, targetUserId: Number(senderId) || 0 };
}

export function detectActiveCommunicationOptIn(text, { directedAtBot = false } = {}) {
    if (!directedAtBot) return false;
    return /(?:можешь|можно|давай)\s+(?:меня\s+)?(?:подкалывать|стебать|доставать)|подкалывай\s+меня/iu.test(String(text ?? ''));
}

export function isInitiativeOptedOut({ peerId, targetUserId, getState } = {}) {
    if (!isActiveCommunicationPolicyPeer(peerId)) return false;
    const state = createActiveCommunicationPolicyState(getState?.() || {});
    return Boolean(state.optOut[String(Number(targetUserId) || 0)]);
}

export function setInitiativeOptOut({ peerId, targetUserId, optedOut, getState, setState, nowSec = Math.floor(Date.now() / 1000) } = {}) {
    if (!isActiveCommunicationPolicyPeer(peerId)) return;
    const state = createActiveCommunicationPolicyState(getState?.() || {});
    const key = String(Number(targetUserId) || 0);
    if (optedOut) state.optOut[key] = { at: nowSec };
    else delete state.optOut[key];
    state.updatedAt = nowSec;
    setState?.(state);
}
