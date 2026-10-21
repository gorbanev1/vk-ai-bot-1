function normalizeCommandText(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .replace(/[«»"'`]/gu, ' ')
        .replace(/[.,!?;:]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

function stripBotPrefix(value) {
    return normalizeCommandText(value)
        .replace(/^\/?(?:гигорейв|gigorave)\s+/iu, '')
        .trim();
}

function parseDaysToken(value) {
    const text = String(value ?? '').trim().toLowerCase();
    if (!text) return null;
    if (/^(?:день|сутки|1\s+(?:день|дня|дней|сутки))$/iu.test(text)) {
        return { kind: 'rolling', days: 1, label: 'день' };
    }
    if (/^(?:неделя|7\s+(?:дней|дня|день|суток))$/iu.test(text)) {
        return { kind: 'rolling', days: 7, label: 'неделя' };
    }
    const match = text.match(/^(\d{1,3})\s*(?:день|дня|дней|сутки|суток)$/iu);
    if (!match) return null;
    const days = Number(match[1]);
    if (!Number.isSafeInteger(days) || days < 1 || days > 365) return null;
    return { kind: 'rolling', days, label: `${days} дн.` };
}

export function parseLeaverCommand(value) {
    const text = stripBotPrefix(value).toLowerCase();
    if (!text) return { matched: false };

    const base = text.match(/^(?:(?:покажи|дай)\s+)?(?:(?:полный\s+)?список\s+)?(?:кто\s+)?(?:вышел|вышли|выходил|выходили|уходил|уходили|вышедшие|вышедших)(?:\s+из\s+(?:этой\s+)?(?:конфы|конференции|чата|беседы))?(?:\s+за\s+(?:всё|все)\s+время)?(?:\s+(.*))?$/iu);
    if (!base) return { matched: false };

    const tail = String(base[1] ?? '').trim();
    if (!tail) {
        return { matched: true, action: 'report', period: { kind: 'all', days: 0, label: 'всё время' } };
    }

    if (/^(?:сегодня|за\s+сегодня)$/iu.test(tail)) {
        return { matched: true, action: 'report', period: { kind: 'today', days: 0, label: 'сегодня' } };
    }
    if (/^(?:вчера|за\s+вчера)$/iu.test(tail)) {
        return { matched: true, action: 'report', period: { kind: 'yesterday', days: 0, label: 'вчера' } };
    }
    const explicitDate = tail.match(/^(?:за\s+)?(\d{1,2})(?:\s+|[./-])(\d{1,2})(?:(?:\s+|[./-])(\d{2}|\d{4}))?$/u);
    if (explicitDate) {
        const day = Number(explicitDate[1]);
        const month = Number(explicitDate[2]);
        let year = explicitDate[3] ? Number(explicitDate[3]) : 0;
        if (year > 0 && year < 100) year += 2000;
        if (day >= 1 && day <= 31 && month >= 1 && month <= 12 && (year === 0 || (year >= 2000 && year <= 2200))) {
            return {
                matched: true,
                action: 'report',
                period: { kind: 'date', day, month, year, label: `${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}${year ? `.${year}` : ''}` },
            };
        }
    }
    if (/^(?:на\s+)?этой\s+неделе$/iu.test(tail) || /^текущая\s+неделя$/iu.test(tail)) {
        return { matched: true, action: 'report', period: { kind: 'current-week', days: 0, label: 'эта неделя' } };
    }

    const autoMatch = tail.match(/^авто(?:\s+(.*))?$/iu);
    if (autoMatch) {
        const autoTail = String(autoMatch[1] ?? '').trim();
        if (!autoTail || /^(?:статус|status)$/iu.test(autoTail)) {
            return { matched: true, action: 'auto-status' };
        }
        if (/^(?:выкл|выключить|откл|отключить|off)$/iu.test(autoTail)) {
            return { matched: true, action: 'auto-disable' };
        }
        const period = parseDaysToken(autoTail);
        if (period) {
            return { matched: true, action: 'auto-enable', period };
        }
        return { matched: true, action: 'auto-invalid' };
    }

    const rolling = parseDaysToken(tail.replace(/^за\s+/iu, ''));
    if (rolling) {
        return { matched: true, action: 'report', period: rolling };
    }

    return { matched: false };
}

export function parseParticipantDmBroadcastCommand(value) {
    const raw = String(value ?? '').normalize('NFKC').trim();
    const withoutBot = raw.replace(/^\/?(?:гигорейв|gigorave)\s+/iu, '').trim();
    const prefix = withoutBot.match(/^(?:лс|личка|рассылка)\s+участникам\s+(.+)$/isu);
    if (!prefix) return { matched: false };

    let rest = String(prefix[1] ?? '').trim();
    let activeDays = 0;
    const active = rest.match(/^активным\s+(?:(\d{1,3})\s*(?:день|дня|дней|сутки|суток)|недел[яю])\s+([\s\S]+)$/iu);
    if (active) {
        activeDays = active[1] ? Number(active[1]) : 7;
        rest = String(active[2] ?? '').trim();
    }

    if (!rest) return { matched: true, invalid: true, activeDays };
    if (activeDays && (!Number.isSafeInteger(activeDays) || activeDays < 1 || activeDays > 365)) {
        return { matched: true, invalid: true, activeDays: 0 };
    }

    return {
        matched: true,
        invalid: false,
        activeDays,
        message: rest,
    };
}
