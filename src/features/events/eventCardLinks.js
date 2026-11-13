import { canonicalizeEventVenue, getCanonicalVenuePublisherUrl } from './eventVenueCatalog.js';
import { buildAppleCalendarLinks } from './eventCalendar.js';

function isTelegramPlatform(platform) {
    const normalized = String(platform ?? '').trim().toLowerCase();
    return normalized === 'telegram' || normalized === 'tg';
}

function escapeHtml(value) {
    return String(value ?? '').replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replaceAll('\"', '&quot;');
}

function buildTelegramVenueHtml(visibleVenue, venueData, platform) {
    const comma = visibleVenue.indexOf(',');
    const name = comma >= 0 ? visibleVenue.slice(0, comma).trim() : visibleVenue.trim();
    const address = comma >= 0 ? visibleVenue.slice(comma + 1).trim() : '';
    const publisherUrl = getCanonicalVenuePublisherUrl(name, platform);
    const nameHtml = publisherUrl
        ? '<a href="' + escapeHtml(publisherUrl) + '">' + escapeHtml(name) + '</a>'
        : escapeHtml(name);
    if (!address) return nameHtml;
    const addressHtml = venueData.url
        ? '<a href="' + escapeHtml(venueData.url) + '">' + escapeHtml(address) + '</a>'
        : escapeHtml(address);
    return nameHtml + ', ' + addressHtml;
}

// Keep photo captions below Telegram's 1024-character limit with a small
// transport reserve. The limit includes the complete card, not only the
// announcement body.
function fitTelegramCaptionText(value, limit = 1000) {
    const source = String(value ?? '').trim();
    if (source.length <= limit) return source;
    const suffix = '…';
    const target = Math.max(1, limit - suffix.length);
    let cut = source.lastIndexOf('\n\n', target);
    if (cut < Math.floor(target * 0.6)) cut = source.lastIndexOf('\n', target);
    if (cut < Math.floor(target * 0.6)) cut = source.lastIndexOf(' ', target);
    if (cut < Math.floor(target * 0.6)) cut = target;
    return `${source.slice(0, cut).trimEnd()}${suffix}`.slice(0, limit);
}

function buildTelegramHtml(message, { event, platform }) {
    const text = String(message ?? '');
    const venueData = getEventVenueLinkData(event);
    const venueLine = /(^|\n)(📍\s*)([^\r\n]*)/u.exec(text);
    if (!venueLine) return escapeHtml(text);
    const rawVenue = venueLine[3];
    const visibleVenue = rawVenue.trim();
    if (!visibleVenue) return escapeHtml(text);
    const leading = rawVenue.match(/^\s*/u)?.[0] || '';
    const trailing = rawVenue.match(/\s*$/u)?.[0] || '';
    const venueStart = venueLine.index + venueLine[1].length + venueLine[2].length;
    const contentStart = venueStart + leading.length;
    const contentEnd = venueStart + rawVenue.length - trailing.length;
    const prefix = text.slice(0, contentStart);
    const suffix = text.slice(contentEnd);
    return `${escapeHtml(prefix)}${buildTelegramVenueHtml(visibleVenue, venueData, platform)}${escapeHtml(suffix)}`;
}

function normalizeHandle(value) {
    return String(value ?? '').trim().replace(/^@/u, '').replace(/^https?:\/\/(?:www\.)?(?:vk\.com|vk\.ru|t\.me)\//iu, '').replace(/\/$/u, '');
}

export function getEventPublisherUrl(event) {
    const type = String(event?.sourceType ?? event?.source_type ?? '').trim().toLowerCase();
    const name = normalizeHandle(event?.sourceName ?? event?.source_name ?? event?.screenName ?? event?.channel ?? '');
    if ((type === 'vk' || type === 'vk_public' || type === 'vk-public') && /^[a-z0-9_.-]{2,80}$/iu.test(name)) {
        return `https://vk.ru/${name}`;
    }
    if ((type === 'telegram' || type === 'tg') && /^[a-z0-9_]{3,64}$/iu.test(name)) {
        return `https://t.me/${name}`;
    }
    const original = String(event?.sourceOriginalUrl ?? event?.source_original_url ?? event?.sourceUrl ?? event?.source_url ?? '').trim();
    try {
        const url = new URL(original);
        if (['vk.ru', 'vk.com', 't.me', 'telegram.me'].includes(url.hostname.toLowerCase())) return url.href;
    } catch {}
    return '';
}

export function getEventVenueLinkData(event) {
    const raw = String(event?.venue ?? '').replace(/\s+/gu, ' ').trim();
    if (!raw || /^(?:город|место не указано|не указано)$/iu.test(raw)) return { text: raw, url: '' };
    const mismatch = raw.match(/\s*❓\(([^)]{1,180})\)❓/u)?.[0] || '';
    const base = raw.replace(/\s*❓\(([^)]{1,180})\)❓/u, '').trim();
    const normalized = canonicalizeEventVenue(base);
    const display = normalized.matched
        ? `${normalized.venue}${mismatch && !normalized.venue.includes('❓(') ? mismatch : ''}`
        : raw;
    const query = normalized.matched
        ? [normalized.canonicalName, normalized.canonicalAddress, 'Воронеж'].filter(Boolean).join(', ')
        : `${base}${/воронеж/iu.test(base) ? '' : ', Воронеж'}`;
    if (!query || query.length < 4) return { text: display, url: '' };
    return { text: display, url: `https://yandex.ru/maps/?text=${encodeURIComponent(query)}` };
}

export function getDisplayEventVenue(event) {
    return getEventVenueLinkData(event).text;
}

export function buildVkEventCardKeyboard(event, { calendarEndpoint = '', calendarSecret = '', timeZone = 'Europe/Moscow' } = {}) {
    const links = [
        ['🔗 Источник', getEventPublisherUrl(event)],
    ].filter(([, url]) => /^https:\/\//iu.test(String(url || '')));
    const venueLink = getEventVenueLinkData(event);
    if (venueLink.url) links.push(['📍 Адрес на Яндекс.Картах', venueLink.url]);
    const type = String(event?.sourceType ?? event?.source_type ?? '').trim().toLowerCase();
    const id = Number(event?.id);
    const validIdentity = /^[a-z_]{2,16}$/u.test(type) && Number.isSafeInteger(id) && id > 0;
    const buttons = links.map(([label, link]) => [{ action: { type: 'open_link', label, link, payload: JSON.stringify({ action: 'event_card_link' }) } }]);
    if (validIdentity && eventDateAvailable(event)) {
        buttons.push([{ action: { type: 'callback', label: '🔔 Попросить напомнить (в этом чате)', payload: JSON.stringify({ action: 'event_remind', sourceType: type, id }) } }]);
        buttons.push([{ action: { type: 'callback', label: '🔔 Напомнить всем в день события', payload: JSON.stringify({ action: 'event_remind_group', sourceType: type, id }) } }]);
        const hosted = buildAppleCalendarLinks(event, { endpoint: calendarEndpoint, secret: calendarSecret, timeZone }).options;
        if (hosted) buttons.push([{ action: { type: 'open_link', label: '📅 Добавить в календарь', link: hosted } }]);
    }
    if (!buttons.length) return '';
    // Send ASCII-safe JSON over VK to avoid mojibake of Cyrillic/emoji labels.
    return JSON.stringify({
        inline: true,
        buttons,
    }).replace(/[\u007f-\uffff]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

function eventDateAvailable(event) {
    return /^\d{4}[-.]\d{1,2}[-.]\d{1,2}$/u.test(String(event?.eventDate || '').trim());
}

export function getEventCardLinkMarkupExpansion(event, platform = 'vk') {
    if (isTelegramPlatform(platform)) return 0;
    const venue = getEventVenueLinkData(event).text;
    if (!venue) return 0;
    const commaIndex = venue.indexOf(',');
    const name = commaIndex >= 0 ? venue.slice(0, commaIndex).trim() : venue;
    let expansion = 0;
    const publisherUrl = getCanonicalVenuePublisherUrl(name, platform);
    if (publisherUrl) {
        expansion += `[${publisherUrl}|${name}]`.length - name.length;
    }
    return expansion;
}

export function buildEventCardLinkMarkup(message, { event, title = '', venue = '', platform = 'vk', compactIndex = null } = {}) {
    let text = String(message ?? '');
    const venueData = getEventVenueLinkData(event);
    const venueLine = text.match(/(?:^|\n)📍\s*([^\n]+)/u);
    const visibleVenue = String(venueLine?.[1] || venueData.text || venue || '').trim();
    const venueStart = venueLine
        ? venueLine.index + venueLine[0].length - venueLine[1].length
        : -1;
    const venueLeadingWhitespace = venueLine?.[1].match(/^\s*/u)?.[0].length || 0;
    const venueOffset = venueStart >= 0 ? venueStart + venueLeadingWhitespace : -1;
    const links = [];
    const commaIndex = visibleVenue.indexOf(',');
    const venueName = commaIndex >= 0 ? visibleVenue.slice(0, commaIndex).trim() : visibleVenue;
    const publisherUrl = getCanonicalVenuePublisherUrl(venueName, platform);
    if (visibleVenue && venueOffset >= 0 && publisherUrl && venueName) {
        links.push({ label: venueName, url: publisherUrl, offset: venueOffset });
    }
    links.sort((left, right) => right.offset - left.offset);
    const safeLinks = links
        .filter((item) => item.label && item.url && item.offset >= 0)
        .sort((left, right) => right.offset - left.offset);
    if (isTelegramPlatform(platform)) {
        const html = buildTelegramHtml(text, { event, platform });
        const captionText = fitTelegramCaptionText(text);
        const htmlCaption = captionText === text.trim() ? html : buildTelegramHtml(captionText, { event, platform });
        return { text, entities: [], html, htmlCaption };
    }
    for (const link of safeLinks) {
        const escapedLabel = String(link.label).replace(/\|/gu, '').trim();
        if (!escapedLabel) continue;

        const safeUrl = String(link.url).replace(/\|/gu, '%7C').replace(/\]/gu, '%5D');
        if (safeUrl.length > 1024 || /\s/.test(safeUrl)) continue;

        text = text.slice(0, link.offset) + `[${safeUrl}|${escapedLabel}]` + text.slice(link.offset + link.label.length);
    }
    if (compactIndex != null) text = text.replace(/\n\n1\. /u, `\n\n${Number(compactIndex) || 1}. `);
    return { text, entities: [] };
}
