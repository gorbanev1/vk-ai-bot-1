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

function sanitizePrivateErrorMessage(value) {
    return String(value ?? '')
        .replace(
            /\bNVIDIA_API_KEY\s*[=:]\s*["']?[^"'\s,;]+["']?/giu,
            'NVIDIA_API_KEY=[NVIDIA_API_KEY_REDACTED]',
        )
        .replace(
            /(?:Bearer\s+)?nvapi-[A-Za-z0-9_-]{8,}/giu,
            '[NVIDIA_API_KEY_REDACTED]',
        )
        .replace(/(?:Bearer\s+)?sk-[A-Za-z0-9_-]{8,}/gu, '[API_KEY_REDACTED]')
        .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/giu, '[IMAGE_DATA_REDACTED]')
        .replace(/https?:\/\/[^\s]+/giu, '[URL_REDACTED]')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 700);
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
