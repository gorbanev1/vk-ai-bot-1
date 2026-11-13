import { buildEventCardLinkMarkup } from './eventCardLinks.js';
import { splitTelegramLongReply } from '../../platforms/telegram/telegramLongReply.js';

const escapeHtml = value => String(value).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');

/** Split a compact VK listing at whole-card boundaries. A short request must
 * never silently truncate a long list to fit VK's message length limit. */
export function packCompactVkEventList(message, maxChars = 3500) {
    const limit = Math.max(500, Math.min(4096, Number(maxChars) || 3500));
    const sections = String(message ?? '').trim().split(/\n\n/gu).filter(Boolean);
    const chunks = [];
    let current = '';
    const flush = () => {
        if (current) chunks.push(current);
        current = '';
    };
    for (const section of sections) {
        let rest = section;
        while (rest) {
            const separator = current ? '\n\n' : '';
            if (current.length + separator.length + rest.length <= limit) {
                current += separator + rest;
                break;
            }
            if (current) {
                flush();
                continue;
            }
            // Oversized individual cards are exceptional (e.g. a huge event
            // schedule). Preserve the entire text instead of losing the tail.
            let cut = rest.lastIndexOf('\n', limit);
            if (cut < Math.floor(limit / 2)) cut = rest.lastIndexOf(' ', limit);
            if (cut < Math.floor(limit / 2)) cut = limit;
            current = rest.slice(0, cut).trimEnd();
            rest = rest.slice(cut).trimStart();
            flush();
        }
    }
    flush();
    return chunks;
}

/** Pack whole numbered entries, counting visible UTF-16 text rather than HTML URLs.
 * Numbering is supplied by the caller and never restarts at a message boundary. */
export function packCompactTelegramEventList(cards, heading, { limit = 4096, platform = 'telegram', trackEvents = false } = {}) {
    const entries = (Array.isArray(cards) ? cards : []).filter(card => card?.text);
    if (!entries.length) return [];
    const messages = [];
    let current = { text: String(heading || ''), html: escapeHtml(heading || ''), ...(trackEvents ? {completedEvents:[]} : {}) };
    const append = (part, completedEvent = null) => {
        const separator = current.text ? '\n\n' : '';
        if (current.text.length + separator.length + part.text.length > limit) {
            if (current.text) messages.push(current);
            current = { text: '', html: '', ...(trackEvents ? {completedEvents:[]} : {}) };
        }
        const join = current.text ? '\n\n' : '';
        current.text += join + part.text;
        current.html += join + (part.html ?? escapeHtml(part.text));
        if(trackEvents && completedEvent) current.completedEvents.push(completedEvent);
    };
    for (const card of entries) {
        if (card.text.length <= limit - String(heading || '').length - 2) {
            append(card, card.event);
            continue;
        }
        // Defensive fallback for exceptionally long source URLs/date schedules.
        // Rebuild markup after splitting; never slice an HTML tag or an emoji.
        const fragmentLimit = Math.min(4000, limit - String(heading || '').length - 2);
        const fragments=splitTelegramLongReply(card.text, fragmentLimit);
        fragments.forEach((text,index)=>append(buildEventCardLinkMarkup(text, {event:card.event,platform}), index===fragments.length-1?card.event:null));
    }
    if (current.text) messages.push(current);
    return messages;
}
