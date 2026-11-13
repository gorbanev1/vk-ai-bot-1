import { getLocalDateString, zonedDateTimeToUtcMilliseconds } from '../../shared/date.js';

export const MEDIUM_VK_MESSAGE_LIMIT = 2048;
export const MEDIUM_SUMMARY_PROMPT = [
    'Режим «средне/среднее»: пиши содержательно, но предельно лаконично.',
    'Ориентир — 700–1200 символов основного текста; если фактов мало, ещё короче.',
    'Максимум ВСЕГО сообщения ВК вместе с заголовком — 2048 символов, половина от 4096.',
    'Не добавляй общих вступлений, пустых слов, повторов. Сохраняй важные события, имена, решения, незакрытые вопросы.',
].join(' ');
export function extractAutoSummaryModifiers(text) {
    let rest = String(text || '').toLowerCase().replace(/ё/gu, 'е');
    const preferences = {};
    if (/(?:^|\s)средн(?:е|ее)(?=\s|$)/u.test(rest)) {
        preferences.medium = true;
        rest = rest.replace(/(?:^|\s)средн(?:е|ее)(?=\s|$)/gu, ' ');
    }
    const slot = (h, m) => String(Number(h)).padStart(2, '0') + ':' + String(Number(m)).padStart(2, '0');
    rest = rest.replace(/(?:^|\s)недельн(?:ое|ый|ая)(?:\s+(?:в\s*)?([01]?\d|2[0-3]):([0-5]?\d))?(?=\s|$)/gu,
        (_, h, m) => { preferences.weeklyEnabled = true; preferences.weeklyAt = h == null ? '20:00' : slot(h, m); return ' '; });
    rest = rest.replace(/(?:^|\s)месячн(?:ое|ый|ая)(?:\s+(?:в\s*)?([01]?\d|2[0-3]):([0-5]?\d))?(?=\s|$)/gu,
        (_, h, m) => { preferences.monthlyEnabled = true; preferences.monthlyAt = h == null ? '18:00' : slot(h, m); return ' '; });
    if (/(?:^|\s)дневн(?:ое|ый|ая)(?=\s|$)/u.test(rest)) {
        preferences.dailyEnabled = true;
        rest = rest.replace(/(?:^|\s)дневн(?:ое|ый|ая)(?=\s|$)/gu, ' ');
    }
    return { text: rest.replace(/\s+/gu, ' ').trim(), preferences, hasModifiers: Object.keys(preferences).length > 0 };
}
export function normalizeAutoSummaryPreferences(value = {}) {
    const p = value && typeof value === 'object' ? value : {};
    return {
        medium: Boolean(p.medium), dailyEnabled: Boolean(p.dailyEnabled),
        weeklyEnabled: Boolean(p.weeklyEnabled), monthlyEnabled: Boolean(p.monthlyEnabled),
        weeklyAt: /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(String(p.weeklyAt || '')) ? p.weeklyAt : '20:00',
        monthlyAt: /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(String(p.monthlyAt || '')) ? p.monthlyAt : '18:00',
        updatedAt: Number(p.updatedAt || 0),
    };
}
export function mediumSummaryMessage(value) {
    const text = String(value ?? '').trim();
    if (text.length <= MEDIUM_VK_MESSAGE_LIMIT) return text;
    const part = text.slice(0, MEDIUM_VK_MESSAGE_LIMIT);
    const wordEnd = part.lastIndexOf(' ', MEDIUM_VK_MESSAGE_LIMIT - 1);
    return part.slice(0, wordEnd > 1800 ? wordEnd : MEDIUM_VK_MESSAGE_LIMIT).trim();
}
const dayShift = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const timestamp = (day, clock, timeZone) => {
    const [hour, minute] = clock.split(':').map(Number);
    return Math.floor(zonedDateTimeToUtcMilliseconds(day, hour, minute, timeZone) / 1000);
};
export function dueAutoSummaryPeriodicPeriods(now, input, timeZone = 'Europe/Moscow') {
    const prefs = normalizeAutoSummaryPreferences(input), nowDate = new Date(now);
    const nowSec = Math.floor(nowDate.getTime() / 1000), today = getLocalDateString(nowDate, timeZone), periods = [];
    const append = (kind, key, startDate, endDate, clock, maxAge, label) => {
        const startAt = timestamp(startDate, '00:00', timeZone), endAt = timestamp(endDate, clock, timeZone);
        if (endAt > nowSec || nowSec - endAt > maxAge || (prefs.updatedAt && endAt < prefs.updatedAt)) return;
        periods.push({ kind, key, startAt, endAt, scheduledAt: endAt, summaryDate: key, slotLabel: 'period:' + kind + ':' + clock, label });
    };
    if (prefs.dailyEnabled) for (let offset = 1; offset <= 2; offset++) {
        const day = dayShift(today, -offset);
        append('daily', day, day, dayShift(day, 1), '00:00', 2 * 86400, 'День ' + day);
    }
    if (prefs.weeklyEnabled) for (let offset = 0; offset < 10; offset++) {
        const day = dayShift(today, -offset);
        if (new Date(day + 'T00:00:00Z').getUTCDay() !== 0) continue;
        append('weekly', day, dayShift(day, -6), day, prefs.weeklyAt, 9 * 86400,
            'Неделя ' + dayShift(day, -6) + ' — ' + day);
    }
    if (prefs.monthlyEnabled) for (let offset = 0; offset < 45; offset++) {
        const day = dayShift(today, -offset);
        if (dayShift(day, 1).slice(0, 7) === day.slice(0, 7)) continue;
        append('monthly', day.slice(0, 7), day.slice(0, 7) + '-01', day, prefs.monthlyAt, 45 * 86400,
            'Месяц ' + day.slice(0, 7));
    }
    return periods.sort((a, b) => a.scheduledAt - b.scheduledAt);
}