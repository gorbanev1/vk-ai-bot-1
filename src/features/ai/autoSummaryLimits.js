export const AUTO_SUMMARY_LIMIT_KEYS = Object.freeze([
    'intraday_chars',
    'intraday_paragraphs',
    'daily_chars',
    'workweek_chars',
    'weekend_chars',
    'week_chars',
    'month_chars',
    'season_chars',
    'year_chars',
]);

export const DEFAULT_AUTO_SUMMARY_LIMITS = Object.freeze({
    intraday_chars: 1_296,
    intraday_paragraphs: 8,
    daily_chars: 3_600,
    workweek_chars: 4_320,
    weekend_chars: 3_840,
    week_chars: 4_800,
    month_chars: 4_080,
    season_chars: 6_000,
    year_chars: 10_800,
});

const LIMIT_ALIASES = Object.freeze({
    intraday: 'intraday_chars',
    batch: 'intraday_chars',
    батч: 'intraday_chars',
    внутридневной: 'intraday_chars',
    внутридневное: 'intraday_chars',
    intraday_chars: 'intraday_chars',
    paragraphs: 'intraday_paragraphs',
    paragraph: 'intraday_paragraphs',
    абзацы: 'intraday_paragraphs',
    абзац: 'intraday_paragraphs',
    intraday_paragraphs: 'intraday_paragraphs',
    daily: 'daily_chars',
    day: 'daily_chars',
    суточное: 'daily_chars',
    дневное: 'daily_chars',
    daily_chars: 'daily_chars',
    workweek: 'workweek_chars',
    рабочая: 'workweek_chars',
    рабочая_неделя: 'workweek_chars',
    workweek_chars: 'workweek_chars',
    weekend: 'weekend_chars',
    выходные: 'weekend_chars',
    weekend_chars: 'weekend_chars',
    week: 'week_chars',
    неделя: 'week_chars',
    week_chars: 'week_chars',
    month: 'month_chars',
    месяц: 'month_chars',
    month_chars: 'month_chars',
    season: 'season_chars',
    сезон: 'season_chars',
    season_chars: 'season_chars',
    year: 'year_chars',
    год: 'year_chars',
    year_chars: 'year_chars',
});

function normalizeKey(value) {
    const key = String(value ?? '').trim().toLowerCase().replace(/ё/gu, 'е').replace(/[ -]+/gu, '_');
    return LIMIT_ALIASES[key] || '';
}

export function normalizeAutoSummaryLimits(value = {}) {
    const result = { ...DEFAULT_AUTO_SUMMARY_LIMITS };
    for (const key of AUTO_SUMMARY_LIMIT_KEYS) {
        const number = Number(value?.[key]);
        if (Number.isFinite(number) && number > 0) result[key] = Math.trunc(number);
    }
    result.intraday_paragraphs = Math.max(1, Math.min(30, result.intraday_paragraphs));
    for (const key of AUTO_SUMMARY_LIMIT_KEYS.filter((item) => item !== 'intraday_paragraphs')) {
        result[key] = Math.max(400, Math.min(100_000, result[key]));
    }
    return result;
}

export function parseAutoSummaryLimits(value) {
    const updates = {};
    const errors = [];
    const text = String(value ?? '').replace(/\r\n?/gu, '\n');
    const lines = text.split(/\n|[,;]+/gu).map((line) => line.trim()).filter(Boolean);
    const aliases = Object.keys(LIMIT_ALIASES)
        .sort((a, b) => b.length - a.length)
        .map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/_/gu, '[ _-]+'));
    const pairPattern = new RegExp(`(?:^|\\s|[-•*])(${aliases.join('|')})(?:\\s*(?:=|:)\\s*|\\s+)(\\d{1,6})(?=\\s|$)`, 'giu');
    const addPair = (keyText, numberText) => {
        const key = normalizeKey(keyText);
        if (key) updates[key] = Number(numberText);
    };
    for (const line of lines) {
        const cleanLine = line.replace(/#.*$/u, '').trim();
        let found = 0;
        for (const match of cleanLine.matchAll(pairPattern)) {
            addPair(match[1], match[2]);
            found += 1;
        }
        if (!found) errors.push(`Не понял строку: ${line}`);
    }
    return { updates, errors, recognized: Object.keys(updates).length };
}

export function formatAutoSummaryLimits(value = {}) {
    const limits = normalizeAutoSummaryLimits(value);
    return [
        `intraday_chars = ${limits.intraday_chars}`,
        `intraday_paragraphs = ${limits.intraday_paragraphs}`,
        `daily_chars = ${limits.daily_chars}`,
        `workweek_chars = ${limits.workweek_chars}`,
        `weekend_chars = ${limits.weekend_chars}`,
        `week_chars = ${limits.week_chars}`,
        `month_chars = ${limits.month_chars}`,
        `season_chars = ${limits.season_chars}`,
        `year_chars = ${limits.year_chars}`,
    ].join('\n');
}
