/**
 * Полная диагностическая форма для консоли. Она не предназначена для отправки
 * пользователю: stack и cause могут содержать внутренние детали приложения.
 */
export function formatError(error) {
    return error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
            cause: error.cause,
        }
        : error;
}

function sanitizePrivateErrorMessage(value, { maxLength = 700, preserveDiagnosticUrls = false } = {}) {
    let message = String(value ?? '')
        .replace(
            /\bNVIDIA_API_KEY\s*[=:]\s*["']?[^"'\s,;]+["']?/giu,
            'NVIDIA_API_KEY=[NVIDIA_API_KEY_REDACTED]',
        )
        .replace(
            /(?:Bearer\s+)?nvapi-[A-Za-z0-9_-]{8,}/giu,
            '[NVIDIA_API_KEY_REDACTED]',
        )
        .replace(/(?:Bearer\s+)?sk-[A-Za-z0-9_-]{8,}/gu, '[API_KEY_REDACTED]')
        .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/giu, '[IMAGE_DATA_REDACTED]');
    if (preserveDiagnosticUrls) {
        message = message.replace(/([?&](?:token|api[_-]?key|access[_-]?token|signature|sig|x-amz-[^=]+)=)[^&#\s]+/giu, '$1[REDACTED]');
    } else {
        message = message.replace(/https?:\/\/[^\s]+/giu, '[URL_REDACTED]');
    }
    return message
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, Math.max(1, Number(maxLength) || 700));
}

/**
 * Безопасная краткая ошибка для ЛС: без stack, API-ключей, URL и тела ответа.
 */
export function formatPrivateError(error) {
    if (!(error instanceof Error)) {
        return {
            type: typeof error,
            value: sanitizePrivateErrorMessage(error),
        };
    }

    return {
        name: error.name,
        message: sanitizePrivateErrorMessage(error.message),
        code: error.code ?? error.cause?.code ?? null,
        status: error.status ?? error.statusCode ?? null,
    };
}

/**
 * Full user-visible diagnostics for owner chat. Unlike the terse log helper,
 * this preserves the whole safe message and a short cause chain while still
 * removing credentials, signed URLs and binary image payloads.
 */
export function formatDetailedPrivateError(error, { maxLength = 8000, maxCauseDepth = 4 } = {}) {
    const visit = (value, depth) => {
        if (!(value instanceof Error)) {
            return { value: sanitizePrivateErrorMessage(value, { maxLength }) };
        }
        const details = {
            name: String(value.name || 'Error').slice(0, 120),
            message: sanitizePrivateErrorMessage(value.message, { maxLength, preserveDiagnosticUrls: true }),
            code: value.code ?? value.cause?.code ?? null,
            status: value.status ?? value.statusCode ?? value.cause?.status ?? value.cause?.statusCode ?? null,
        };
        if (depth < maxCauseDepth && value.cause != null) details.cause = visit(value.cause, depth + 1);
        return details;
    };
    return visit(error, 0);
}
