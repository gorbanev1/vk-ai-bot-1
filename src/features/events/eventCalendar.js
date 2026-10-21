import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';

const DEFAULT_DURATION_MINUTES = 120;

// Platform-neutral RFC 5545 export. Telegram transports the .ics file;
// iPhone, Android and Huawei Calendar decide how to import/open it.

function text(value) {
    return String(value ?? '').trim();
}

function escapeIcs(value) {
    return text(value)
        .split('\\').join('\\\\')
        .split(/\r?\n/gu).join('\\n')
        .split(';').join('\\;')
        .split(',').join('\\,');
}

function foldIcsLine(line, maxBytes = 74) {
    const source = String(line ?? '');
    if (Buffer.byteLength(source, 'utf8') <= maxBytes) return source;
    const chunks = [];
    let current = '';
    for (const character of source) {
        const candidate = current + character;
        if (Buffer.byteLength(candidate, 'utf8') > maxBytes && current) {
            chunks.push(current);
            current = character;
        } else current = candidate;
    }
    if (current) chunks.push(current);
    return chunks.join('\r\n ');
}

function normalizeDate(value) {
    const match = text(value).match(/^(\d{4})[-.](\d{1,2})[-.](\d{1,2})$/u);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
    return String(year).padStart(4, '0') + String(month).padStart(2, '0') + String(day).padStart(2, '0');
}

function normalizeTime(value) {
    const match = text(value).match(/(?:^|\D)([01]?\d|2[0-3])[:.](\d{2})(?::(\d{2}))?/u);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const second = Number(match[3] || 0);
    return String(hour).padStart(2, '0') + String(minute).padStart(2, '0') + String(second).padStart(2, '0');
}

function localDateTimeToUtc(date, time, timeZone) {
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(4, 6)) - 1;
    const day = Number(date.slice(6, 8));
    const hour = Number(time.slice(0, 2));
    const minute = Number(time.slice(2, 4));
    const second = Number(time.slice(4, 6));
    const wallTime = Date.UTC(year, month, day, hour, minute, second);
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(wallTime));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const renderedAsUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day),
        Number(values.hour), Number(values.minute), Number(values.second));
    return new Date(wallTime - (renderedAsUtc - wallTime));
}

function dateStamp(date) {
    return String(date.getUTCFullYear()).padStart(4, '0') +
        String(date.getUTCMonth() + 1).padStart(2, '0') +
        String(date.getUTCDate()).padStart(2, '0');
}

function nextDateStamp(date) {
    const next = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)) + 1));
    return dateStamp(next);
}

function utcStamp(date) {
    return date.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
}

function eventCalendarValues(event, timeZone = 'Europe/Moscow') {
    const date = normalizeDate(event?.eventDate);
    if (!date) return null;
    const time = normalizeTime(event?.eventTime || event?.timeLabel);
    const start = time ? localDateTimeToUtc(date, time, timeZone) : null;
    const end = start
        ? new Date(start.getTime() + Math.max(1, Number(event?.durationMinutes || event?.duration) || DEFAULT_DURATION_MINUTES) * 60_000)
        : null;
    return { date, time, start, end, endDate: time ? '' : nextDateStamp(date) };
}

function makeUid(event) {
    const sourceType = text(event?.sourceType).replace(/[^a-z0-9_-]/giu, '_') || 'event';
    const id = Number(event?.id);
    const sourceUrl = text(event?.sourceUrl || event?.detailUrl);
    if (Number.isSafeInteger(id) && id > 0) return 'gigorave-' + sourceType + '-' + id + '@gigorave';
    let hash = 0;
    for (const character of sourceUrl || text(event?.title)) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
    return 'gigorave-' + Math.abs(hash) + '@gigorave';
}

export function buildEventCalendarIcs(event, { timeZone = 'Europe/Moscow', now = new Date() } = {}) {
    const values = eventCalendarValues(event, timeZone);
    if (!values) return null;
    const title = text(event?.title || event?.participants || 'Мероприятие') || 'Мероприятие';
    const venue = text(event?.venue);
    const sourceUrl = text(event?.sourceUrl || event?.detailUrl || event?.ticketUrl);
    const description = text(event?.announcement || event?.description || event?.summary);
    const dtstamp = utcStamp(new Date(now instanceof Date ? now : Date.now()));
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Gigorave//Event Calendar//RU', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Gigorave'];
    lines.push('BEGIN:VEVENT', 'UID:' + makeUid(event), 'DTSTAMP:' + dtstamp);
    if (values.start && values.end) {
        lines.push('DTSTART:' + utcStamp(values.start), 'DTEND:' + utcStamp(values.end));
    } else {
        lines.push('DTSTART;VALUE=DATE:' + values.date, 'DTEND;VALUE=DATE:' + values.endDate);
    }
    lines.push('SUMMARY:' + escapeIcs(title));
    if (venue) lines.push('LOCATION:' + escapeIcs(venue));
    if (description) lines.push('DESCRIPTION:' + escapeIcs(description));
    if (sourceUrl) lines.push('URL:' + escapeIcs(sourceUrl));
    const alarmUid = makeUid(event).replace('@', '-alarm-1@');
    lines.push(
        'BEGIN:VALARM',
        'UID:' + alarmUid,
        'X-WR-ALARMUID:' + alarmUid,
        'ACTION:DISPLAY',
        'DESCRIPTION:' + escapeIcs('Напоминание за день: ' + title),
        'TRIGGER:-P1D',
        'END:VALARM',
    );
    lines.push('END:VEVENT', 'END:VCALENDAR');
    return Buffer.from(lines.map((line) => foldIcsLine(line)).join('\r\n') + '\r\n', 'utf8');
}

export function buildGoogleCalendarUrl(event, { timeZone = 'Europe/Moscow' } = {}) {
    const values = eventCalendarValues(event, timeZone);
    if (!values) return '';
    const title = text(event?.title || event?.participants || 'Мероприятие') || 'Мероприятие';
    const venue = text(event?.venue);
    const sourceUrl = text(event?.sourceUrl || event?.detailUrl || event?.ticketUrl);
    const description = [text(event?.announcement || event?.description || event?.summary), sourceUrl]
        .filter(Boolean).join('\n\n').slice(0, 2500);
    const dates = values.start && values.end
        ? values.start.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z') + '/' + values.end.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')
        : values.date + '/' + values.endDate;
    const params = new URLSearchParams({ action: 'TEMPLATE', text: title, dates, ctz: timeZone });
    if (venue) params.set('location', venue);
    if (description) params.set('details', description);
    return 'https://calendar.google.com/calendar/render?' + params.toString();
}

export function buildOutlookCalendarUrl(event, { timeZone = 'Europe/Moscow' } = {}) {
    const values = eventCalendarValues(event, timeZone);
    if (!values) return '';
    const title = text(event?.title || event?.participants || 'Мероприятие') || 'Мероприятие';
    const venue = text(event?.venue);
    const sourceUrl = text(event?.sourceUrl || event?.detailUrl || event?.ticketUrl);
    const description = [text(event?.announcement || event?.description || event?.summary), sourceUrl]
        .filter(Boolean).join('\n\n').slice(0, 2500);
    const start = values.start ? values.start.toISOString() : values.date.slice(0, 4) + '-' + values.date.slice(4, 6) + '-' + values.date.slice(6, 8);
    const end = values.end ? values.end.toISOString() : values.endDate.slice(0, 4) + '-' + values.endDate.slice(4, 6) + '-' + values.endDate.slice(6, 8);
    const params = new URLSearchParams({ path: '/calendar/action/compose', rru: 'addevent', subject: title, startdt: start, enddt: end, allday: values.start ? 'false' : 'true' });
    if (venue) params.set('location', venue);
    if (description) params.set('body', description);
    return 'https://outlook.live.com/calendar/0/deeplink/compose?' + params.toString();
}

export function buildEventCalendarLinks(event, { timeZone = 'Europe/Moscow' } = {}) {
    return {
        google: buildGoogleCalendarUrl(event, { timeZone }),
        outlook: buildOutlookCalendarUrl(event, { timeZone }),
    };
}

export function buildHostedCalendarUrl(event, { endpoint = '', secret = '', timeZone = 'Europe/Moscow', download = false, page = '' } = {}) {
    const target = text(endpoint);
    const key = text(secret);
    const values = eventCalendarValues(event, timeZone);
    if (!target || !key || !values) return '';
    let parsed;
    try { parsed = new URL(target); } catch { return ''; }
    if (parsed.protocol !== 'https:') return '';

    const payload = {
        t: text(event?.title || event?.participants || 'Мероприятие').slice(0, 180),
        d: values.date,
        tm: values.time ? values.time.slice(0, 4) : '',
        z: timeZone,
        v: text(event?.venue).slice(0, 180),
        u: text(event?.sourceUrl || event?.detailUrl || event?.ticketUrl).slice(0, 360),
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', key).update(encoded).digest('hex');
    parsed.searchParams.set('e', encoded);
    parsed.searchParams.set('s', signature);
    if (download) parsed.searchParams.set('file', 'ics');
    if (page) parsed.searchParams.set('open', page);
    return parsed.toString();
}

export function buildAppleCalendarLinks(event, options = {}) {
    return {
        subscribe: buildHostedCalendarUrl(event, { ...options, page: 'webcal' }),
        options: buildHostedCalendarUrl(event, { ...options, page: 'options' }),
    };
}

export function eventCalendarAvailability(event) {
    return Boolean(normalizeDate(event?.eventDate));
}

export function eventCalendarFilename(event) {
    const title = text(event?.title || event?.participants || 'мероприятие')
        .replace(/[^\p{L}\p{N}_-]+/gu, '-')
        .replace(/^-+|-+$/gu, '').slice(0, 70) || 'мероприятие';
    return title + '.ics';
}
