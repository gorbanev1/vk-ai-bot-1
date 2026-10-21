const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * HOUR_SECONDS;
const WEEK_SECONDS = 7 * DAY_SECONDS;

export const VK_HISTORY_STARTUP_WINDOW_SECONDS = DAY_SECONDS;
export const VK_HISTORY_STARTUP_MAX_MESSAGES = 3500;

function normalizeCommandText(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[«»"'`]/gu, ' ')
        .replace(/[.,!?;:]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim()
        .replace(/^\/?(?:гигорейв|gigorave)\s+/iu, '')
        .trim();
}

function normalizeDurationUnit(rawUnit) {
    const unit = String(rawUnit ?? '').toLowerCase().replace(/\./gu, '').trim();
    if (/^(?:ч|час|часа|часов)$/iu.test(unit)) {
        return { unit: 'hour', seconds: HOUR_SECONDS };
    }
    if (/^(?:д|дн|день|дня|дней|сутки|суток|сут)$/iu.test(unit)) {
        return { unit: 'day', seconds: DAY_SECONDS };
    }
    if (/^(?:нед|неделя|недели|недель)$/iu.test(unit)) {
        return { unit: 'week', seconds: WEEK_SECONDS };
    }
    return null;
}

function formatDurationLabel(value, unit) {
    if (unit === 'hour') return `${value} ч.`;
    if (unit === 'day') return `${value} дн.`;
    return `${value} нед.`;
}

export function parseVkHistoryPullCommand(value) {
    const text = normalizeCommandText(value);
    const match = text.match(
        /^(?:подтяни|подтянуть|подтяни-ка|докачай|загрузи)\s+истори(?:ю|и)(?:\s+(.+))?$/iu,
    );
    if (!match) return { matched: false };

    const rawRange = String(match[1] ?? '').trim();
    if (!rawRange) {
        return {
            matched: true,
            valid: true,
            durationSeconds: DAY_SECONDS,
            durationLabel: '1 дн.',
            defaulted: true,
        };
    }

    if (/^(?:всю|полностью|с\s+самого\s+начала|с\s+начала|за\s+вс[её]\s+время|вся)$/iu.test(rawRange)) {
        return {
            matched: true,
            valid: true,
            durationSeconds: 0,
            durationLabel: 'всю доступную историю',
            fullHistory: true,
            defaulted: false,
        };
    }

    if (/^(?:сутки|день|1\s*(?:д|дн|день|сутки))$/iu.test(rawRange)) {
        return {
            matched: true,
            valid: true,
            durationSeconds: DAY_SECONDS,
            durationLabel: '1 дн.',
            defaulted: false,
        };
    }
    if (/^(?:неделя|неделю)$/iu.test(rawRange)) {
        return {
            matched: true,
            valid: true,
            durationSeconds: WEEK_SECONDS,
            durationLabel: '1 нед.',
            defaulted: false,
        };
    }

    const durationMatch = rawRange.match(/^(\d{1,4})\s*([\p{L}.]+)$/iu);
    if (!durationMatch) {
        return {
            matched: true,
            valid: false,
            error: 'Укажи период, например: 6 часов, 1 день, 2 дня или 1 неделя.',
        };
    }

    const amount = Number(durationMatch[1]);
    const normalizedUnit = normalizeDurationUnit(durationMatch[2]);
    if (!Number.isSafeInteger(amount) || amount <= 0 || !normalizedUnit) {
        return {
            matched: true,
            valid: false,
            error: 'Укажи период, например: 6 часов, 1 день, 2 дня или 1 неделя.',
        };
    }

    const durationSeconds = amount * normalizedUnit.seconds;
    if (!Number.isSafeInteger(durationSeconds) || durationSeconds <= 0) {
        return {
            matched: true,
            valid: false,
            error: 'Период слишком большой.',
        };
    }

    return {
        matched: true,
        valid: true,
        durationSeconds,
        durationLabel: formatDurationLabel(amount, normalizedUnit.unit),
        defaulted: false,
    };
}

export function getVkHistoryPullCutoffTimestamp({
    nowTimestamp = Math.floor(Date.now() / 1000),
    durationSeconds = VK_HISTORY_STARTUP_WINDOW_SECONDS,
} = {}) {
    const now = Number(nowTimestamp);
    const duration = Number(durationSeconds);
    if (!Number.isFinite(now) || now <= 0 || !Number.isFinite(duration) || duration <= 0) {
        return 0;
    }
    return Math.max(0, Math.floor(now - duration));
}
