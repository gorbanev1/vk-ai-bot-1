import { normalizeEventIdentityTitle, compareEventsDeterministic } from './eventDuplicateResolution.js';
export const PARTY_DELIVERY_COOLDOWN_STATE_VERSION = 2;
export const DEFAULT_PARTY_DELIVERY_COOLDOWN_HOURS = 6;
export const DEFAULT_PARTY_RANGE_COOLDOWN_HOURS = 6;

function safeHours(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(168, Math.max(0, number)) : fallback;
}

export function normalizePartyCooldownHours(value, fallback = DEFAULT_PARTY_DELIVERY_COOLDOWN_HOURS) {
    return safeHours(value, fallback);
}

export function normalizePartyCooldownState(value) {
    const source = value && typeof value === 'object' ? value : {};
    const requests = Array.isArray(source.requests) ? source.requests : [];
    return {
        version: PARTY_DELIVERY_COOLDOWN_STATE_VERSION,
        deliveryHours: normalizePartyCooldownHours(source.deliveryHours, DEFAULT_PARTY_DELIVERY_COOLDOWN_HOURS),
        rangeHours: normalizePartyCooldownHours(source.rangeHours, DEFAULT_PARTY_RANGE_COOLDOWN_HOURS),
        requests: requests
            .filter((item) => item && typeof item === 'object')
            .map((item) => ({
                id: String(item.id || ''),
                signature: upgradePartyRequestSignature(item),
                mode: item.mode === 'compact' ? 'compact' : 'full',
                status: item.status || (item.deliveredKeys?.length ? 'complete' : 'failed'),
                completedAt: Number(item.completedAt || item.createdAt || 0),
                lastDeliveredAt: Number(item.lastDeliveredAt || item.createdAt || 0),
                deliveredEvents: Array.isArray(item.deliveredEvents) ? item.deliveredEvents : [],
                platform: String(item.platform || ''),
                peerId: String(item.peerId || ''),
                messageId: Number(item.messageId || 0) || 0,
                createdAt: Number(item.createdAt || 0) || 0,
                fromDate: String(item.fromDate || ''),
                toDate: String(item.toDate || ''),
                partyPool: String(item.partyPool || ''),
                filters: item.filters && typeof item.filters === 'object' ? item.filters : {},
                deliveredKeys: [...new Set((Array.isArray(item.deliveredKeys) ? item.deliveredKeys : []).map(String).filter(Boolean))],
            }))
            .filter((item) => item.createdAt > 0),
    };
}

export function prunePartyCooldownState(value, nowMs = Date.now(), maxHours = 168) {
    const state = normalizePartyCooldownState(value);
    const cutoff = nowMs - safeHours(maxHours, 168) * 60 * 60 * 1000;
    state.requests = state.requests.filter((item) => item.createdAt >= cutoff);
    return state;
}

export function partyDeliveryEventKey(event) {
    const sourceType = String(event?.sourceType || event?.sourceKind || '').trim().toLowerCase();
    const id = Number(event?.id || event?.eventId || 0);
    if (sourceType && Number.isSafeInteger(id) && id > 0) return `${sourceType}:${id}`;
    const sourceUrl = String(event?.sourceUrl || event?.canonicalPostUrl || '').trim().toLowerCase();
    const date = String(event?.eventDate || event?.dateLabel || '').trim();
    const title = String(event?.title || event?.participants || '').trim().toLowerCase().replace(/\s+/gu, ' ');
    return [sourceUrl, date, title].filter(Boolean).join('|');
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function buildPartyRequestSignature({
    fromDate = '', toDate = '', partyPool = '', filters = null, mode = 'full',
} = {}) {
    return JSON.stringify(stableValue({
        mode: mode === 'compact' ? 'compact' : 'full',
        fromDate: String(fromDate || ''),
        toDate: String(toDate || ''),
        partyPool: String(partyPool || '').toLowerCase(),
        filters: filters && typeof filters === 'object' ? filters : {},
    }));
}

function sameDeliveryScope(left, right) {
    return String(left?.platform || '').toLowerCase() === String(right?.platform || '').toLowerCase() &&
        String(left?.peerId || '') === String(right?.peerId || '') &&
        (String(left?.partyPool || '').toLowerCase() === 'all' || String(right?.partyPool || '').toLowerCase() === 'all' || (left?.mode || 'full') === (right?.mode || 'full')) &&
        JSON.stringify(stableValue(left?.filters || {})) === JSON.stringify(stableValue(right?.filters || {}));
}

function eventScopeMatchesRequest(event, current, previous) {
    if (!sameDeliveryScope(current, previous)) return false;
    const previousPool = String(previous?.partyPool || '').toLowerCase();
    const eventPool = String(event?.partyPool || '').toLowerCase();
    const currentPool = String(current?.partyPool || '').toLowerCase();
    // An unclassified event must never be attached to a primary, secondary,
    // or QTickets request. The aggregate route can only use it when both
    // requests are explicitly aggregate.
    if (previousPool && previousPool !== 'all' && eventPool !== previousPool) return false;
    if (currentPool && currentPool !== 'all' && eventPool !== currentPool) return false;
    return true;
}

function eventRangeOverlaps(event, request) {
    const eventDate = String(event?.eventDate || '').trim();
    const eventEnd = String(event?.eventEndDate || '').trim() || eventDate;
    const from = String(request?.fromDate || '').trim();
    const to = String(request?.toDate || '').trim();
    if (!eventDate || !from || !to) return false;
    return eventDate <= to && eventEnd >= from;
}

export function preparePartyDelivery({
    state, events = [], nowMs = Date.now(), signature = '', request = {}, bypass = false,
    deliveryCooldownHours = DEFAULT_PARTY_DELIVERY_COOLDOWN_HOURS,
    rangeCooldownHours = DEFAULT_PARTY_RANGE_COOLDOWN_HOURS,
} = {}) {
    const safeState = prunePartyCooldownState(state, nowMs);
    const deliveryCutoff = nowMs - normalizePartyCooldownHours(deliveryCooldownHours) * 60 * 60 * 1000;
    const rangeCutoff = nowMs - normalizePartyCooldownHours(rangeCooldownHours) * 60 * 60 * 1000;
    const recent = safeState.requests.filter((item) =>
        item.lastDeliveredAt >= deliveryCutoff &&
        (String(request.partyPool || '').toLowerCase() === 'all' || item.mode === (request.mode || 'full')) &&
        String(item.platform || '').toLowerCase() === String(request.platform || '').toLowerCase() &&
        String(item.peerId || '') === String(request.peerId || ''),
    );
    const previousSameRange = (bypass ? [] : safeState.requests)
        .filter((item) => item.status === 'complete' && item.completedAt >= rangeCutoff && item.signature === signature && item.messageId > 0 && sameDeliveryScope(request, item))
        .sort((left, right) => right.createdAt - left.createdAt);

    const blocked = new Set((bypass ? [] : recent).flatMap((item) => item.deliveredKeys));
    const identityIndex = new Map();
    for (const prior of bypass ? [] : recent) for (const event of prior.deliveredEvents) {
        for (const key of deliveryIdentityAliases(event)) {
            const group = identityIndex.get(key) || []; group.push(event); identityIndex.set(key, group);
        }
    }
    const wasDelivered = event => blocked.has(partyDeliveryEventKey(event)) ||
        deliveryIdentityAliases(event).some(key => (identityIndex.get(key) || []).some(old =>
            compareEventsDeterministic(old, event).verdict === 'same'));

    const requestPool = String(request?.partyPool || '').trim().toLowerCase();
    const sourceEvents = (Array.isArray(events) ? events : []).map((event) => {
        if (!event || typeof event !== 'object' || event.partyPool || requestPool === 'all') return event;
        return { ...event, partyPool: requestPool };
    });
    const eligibleEvents = previousSameRange.length
        ? []
        : sourceEvents.filter((event) => {
        const key = partyDeliveryEventKey(event);
        return !key || !wasDelivered(event);
        });
    const targets = new Map();
    const targetByEventKey = new Map();
    for (const event of eligibleEvents) {
        const matchingPrior = (bypass ? [] : recent)
            .filter((item) => item.messageId > 0 && item.deliveredKeys.length > 0 && eventScopeMatchesRequest(event, request, item) && eventRangeOverlaps(event, item))
            .sort((left, right) => right.createdAt - left.createdAt);
        const eventKey = partyDeliveryEventKey(event);
        const eventTargets = matchingPrior.length
            ? [Number(matchingPrior[0].messageId)]
            : [0];
        if (eventKey) targetByEventKey.set(eventKey, eventTargets);
        for (const target of eventTargets) {
            const list = targets.get(target) || [];
            list.push(event);
            targets.set(target, list);
        }
    }
    const requestRecord = {
        id: `${nowMs}-${Math.random().toString(36).slice(2, 10)}`,
        signature,
        mode: request.mode === 'compact' ? 'compact' : 'full',
        status: 'pending', completedAt: 0, lastDeliveredAt: 0, deliveredEvents: [],
        platform: String(request.platform || ''),
        peerId: String(request.peerId || ''),
        messageId: Number(request.messageId || 0) || 0,
        createdAt: nowMs,
        fromDate: String(request.fromDate || ''),
        toDate: String(request.toDate || ''),
        partyPool: String(request.partyPool || ''),
        filters: request.filters && typeof request.filters === 'object' ? request.filters : {},
        deliveredKeys: [],
    };
    if (!previousSameRange.length && eligibleEvents.length) safeState.requests.push(requestRecord);
    return {
        state: safeState,
        requestRecord,
        sameRange: previousSameRange.length > 0,
        previousSameRange,
        overlapReplyTarget: bypass ? 0 : Number([...recent].sort((a,b)=>b.lastDeliveredAt-a.lastDeliveredAt).find(item =>
            item.messageId > 0 && sourceEvents.some(event => item.deliveredKeys.includes(partyDeliveryEventKey(event)) ||
                item.deliveredEvents.some(old => deliveryIdentityAliases(old).some(k=>deliveryIdentityAliases(event).includes(k)))))?.messageId || 0),
        eligibleEvents,
        blockedEvents: sourceEvents.length - eligibleEvents.length,
        replyGroups: [...targets.entries()].map(([messageId, group]) => ({ messageId, events: group })),
        targetByEventKey,
    };
}

export function latestPartyRangeReplyTarget(prepared) {
    const target = Array.isArray(prepared?.previousSameRange)
        ? prepared.previousSameRange.find((item) => Number(item?.messageId || 0) > 0)
        : null;
    return Number(target?.messageId || 0) || 0;
}

export function markPartyDelivery(state, requestId, events = [], nowMs = Date.now()) {
    const safeState = prunePartyCooldownState(state, nowMs);
    const request = safeState.requests.find((item) => item.id === requestId);
    if (!request) return safeState;
    request.status = 'partial';
    request.lastDeliveredAt = nowMs;
    const facts = new Map(request.deliveredEvents.map(e=>[partyDeliveryEventKey(e),e]));
    for (const event of events) facts.set(partyDeliveryEventKey(event), deliveryEventFacts(event));
    request.deliveredEvents = [...facts.values()];
    request.deliveredKeys = [...new Set([
        ...request.deliveredKeys,
        ...(Array.isArray(events) ? events : []).map(partyDeliveryEventKey).filter(Boolean),
    ])];
    return safeState;
}

export function formatPartyCooldownHours(value) {
    const hours = normalizePartyCooldownHours(value);
    return Number.isInteger(hours) ? String(hours) : hours.toFixed(2).replace(/0+$/u, '').replace(/\.$/u, '');
}

export function parsePartyCooldownCommand(value) {
    const text = String(value ?? '').trim().toLowerCase().replace(/ё/gu, 'е').replace(/\s+/gu, ' ');
    if (!/^тус[ыа]?\s+(?:повтор|повторы|интервал)/u.test(text)) return null;
    if (/(?:статус|настро(?:й|йки)|покажи)/u.test(text)) return { action: 'status' };
    const match = text.match(/(?:карточк|выдач)[а-я]*\s+(\d+(?:[.,]\d+)?)\s*(?:час(?:а|ов)?|ч)?$/u);
    if (match) return { action: 'delivery', hours: Number(String(match[1]).replace(',', '.')) };
    const range = text.match(/(?:диапазон|запрос)[а-я]*\s+(\d+(?:[.,]\d+)?)\s*(?:час(?:а|ов)?|ч)?$/u);
    if (range) return { action: 'range', hours: Number(String(range[1]).replace(',', '.')) };
    return null;
}


function deliveryEventFacts(event) {
    const keys=['id','sourceType','sourceKind','sourceUrl','canonicalPostUrl','eventDate','eventEndDate','eventTime','title','alternativeTitles','participants','venue','eventSchedule'];
    return Object.fromEntries(keys.filter(k=>event?.[k]!==undefined).map(k=>[k,event[k]]));
}
function deliveryIdentityAliases(event) {
    if (!event?.eventDate) return [];
    return [event.title,...(Array.isArray(event.alternativeTitles)?event.alternativeTitles:[])]
        .map(normalizeEventIdentityTitle).filter(Boolean).map(t=>event.eventDate+'|'+t);
}
export function completePartyDelivery(state, requestId, nowMs = Date.now()) {
    const safe=prunePartyCooldownState(state,nowMs),request=safe.requests.find(r=>r.id===requestId);
    if(request){request.status='complete';request.completedAt=nowMs;}
    return safe;
}
export function createPartyDeliveryQueue() {
    const pending=new Map();
    return async (key,task)=>{
        const previous=pending.get(key)||Promise.resolve();
        const current=previous.catch(()=>{}).then(task);
        pending.set(key,current);
        try{return await current;}finally{if(pending.get(key)===current)pending.delete(key);}
    };
}
export const runPartyDeliverySerial=createPartyDeliveryQueue();

function upgradePartyRequestSignature(item) {
    try { const data=JSON.parse(item.signature); return buildPartyRequestSignature({...data,mode:item.mode||data.mode||'full'}); }
    catch { return String(item.signature||''); }
}

/** Reply to a stored VK conversation_message_id using the same forward is_reply
 * transport as HuInglish/Chitvo; Telegram still uses replyToMessageId. */
export function partyCooldownReplyFields(conversationMessageId) {
    const id=Number(conversationMessageId);
    return Number.isSafeInteger(id)&&id>0
        ? {replyWithForwardConversationMessageId:id,replyToConversationMessageId:id,replyToMessageId:id}
        : {};
}
