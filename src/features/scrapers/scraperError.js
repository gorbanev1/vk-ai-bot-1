function sanitizeErrorText(value) {
    return String(value ?? '')
        .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/gu, '[TELEGRAM_TOKEN_REDACTED]')
        .replace(/(?:Bearer\s+)?sk-[A-Za-z0-9_-]{8,}/gu, '[API_KEY_REDACTED]')
        .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/giu, '[IMAGE_DATA_REDACTED]')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 1200);
}

function readPreferredObjectMessage(error) {
    for (const key of [
        'message',
        'error_description',
        'description',
        'detail',
        'reason',
        'error',
    ]) {
        const value = error?.[key];

        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }

    return '';
}

function serializePlainObject(value) {
    const seen = new WeakSet();

    try {
        return JSON.stringify(value, (key, child) => {
            if (/^(?:stack|headers|authorization|token|api[_-]?key|body|request|response|config)$/iu.test(key)) {
                return undefined;
            }

            if (child && typeof child === 'object') {
                if (seen.has(child)) {
                    return '[Circular]';
                }
                seen.add(child);
            }

            return child;
        });
    } catch {
        return '';
    }
}

/**
 * Короткая безопасная ошибка для ответа пользователю. Не возвращает
 * бесполезный текст "[object Object]" и не публикует stack/токены.
 */
export function formatScraperErrorForUser(error) {
    if (error == null) {
        return 'Неизвестная ошибка парсера.';
    }

    if (error instanceof Error) {
        const main = sanitizeErrorText(error.message || error.name);
        const cause = error.cause && error.cause !== error
            ? formatScraperErrorForUser(error.cause)
            : '';

        if (main && cause && main !== cause) {
            return `${main} Причина: ${cause}`.slice(0, 1200);
        }

        return main || cause || 'Неизвестная ошибка парсера.';
    }

    if (typeof error === 'string') {
        return sanitizeErrorText(error) || 'Неизвестная ошибка парсера.';
    }

    if (typeof error !== 'object') {
        return sanitizeErrorText(error) || 'Неизвестная ошибка парсера.';
    }

    const preferred = readPreferredObjectMessage(error);
    const code = error.code ?? error.status ?? error.statusCode ?? null;
    const cause = error.cause && error.cause !== error
        ? formatScraperErrorForUser(error.cause)
        : '';
    const parts = [];

    if (preferred) {
        parts.push(preferred);
    }

    if (code != null && !String(preferred).includes(String(code))) {
        parts.push(`код ${String(code)}`);
    }

    if (cause && !parts.includes(cause)) {
        parts.push(`причина: ${cause}`);
    }

    if (!parts.length) {
        const serialized = serializePlainObject(error);
        if (serialized && serialized !== '{}') {
            parts.push(serialized);
        }
    }

    const result = sanitizeErrorText(parts.join('; '));

    return result && result !== '[object Object]'
        ? result
        : 'Парсер вернул ошибку без текстового описания. Подробности сохранены в консоли.';
}
