function compact(value) {
    return String(value ?? '')
        .replace(/\s+/gu, ' ')
        .trim();
}

function readNestedErrorCode(error) {
    return compact(
        error?.code ??
        error?.cause?.code ??
        error?.cause?.cause?.code ??
        '',
    ).toUpperCase();
}

function readStatus(error) {
    const value = Number(
        error?.status ??
        error?.statusCode ??
        error?.code ??
        error?.cause?.status ??
        0,
    );

    return Number.isFinite(value) ? value : 0;
}

function sanitizeDiagnosticMessage(value) {
    return compact(value)
        .replace(/bot\d+:[A-Za-z0-9_-]+/gu, 'bot<token-hidden>')
        .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/gu, '<token-hidden>')
        .slice(0, 500);
}

export function classifyTelegramConnectionError(error) {
    const code = readNestedErrorCode(error);
    const status = readStatus(error);
    const message = sanitizeDiagnosticMessage(
        error?.message ?? error?.cause?.message ?? error,
    );
    const lower = message.toLowerCase();

    if (status === 401 || /unauthorized|token is invalid|invalid token/iu.test(lower)) {
        return {
            kind: 'invalid-token',
            retryable: false,
            code: code || 'HTTP_401',
            summary: 'Telegram отклонил токен бота (401).',
            advice: 'Отозви старый токен в BotFather, запиши новый TELEGRAM_BOT_TOKEN в .env и перезапусти процесс.',
        };
    }

    if (status === 409 || /conflict|terminated by other getupdates/iu.test(lower)) {
        return {
            kind: 'polling-conflict',
            retryable: false,
            code: code || 'HTTP_409',
            summary: 'Другой экземпляр бота или webhook уже получает Telegram-обновления (409).',
            advice: 'Останови остальные процессы Node и удали webhook перед повторным запуском long polling.',
        };
    }

    if (status === 429 || /too many requests/iu.test(lower)) {
        return {
            kind: 'rate-limit',
            retryable: true,
            code: code || 'HTTP_429',
            summary: 'Telegram временно ограничил частоту запросов (429).',
            advice: 'Подожди и повтори подключение позже.',
        };
    }

    if (
        code === 'ECONNRESET' ||
        /before secure tls connection|tls connection|handshake|connection reset/iu.test(lower)
    ) {
        return {
            kind: 'tls-reset',
            retryable: true,
            code: code || 'ECONNRESET',
            summary: 'Соединение с Telegram сброшено до завершения TLS-рукопожатия.',
            advice: 'Проверь VPN/TUN, антивирусный HTTPS-фильтр, прокси и доступ к api.telegram.org и t.me.',
        };
    }

    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        return {
            kind: 'dns',
            retryable: true,
            code,
            summary: 'Не удалось разрешить DNS-адрес Telegram.',
            advice: 'Проверь DNS, VPN и системный сетевой адаптер.',
        };
    }

    if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || /timeout/iu.test(lower)) {
        return {
            kind: 'timeout',
            retryable: true,
            code: code || 'TIMEOUT',
            summary: 'Telegram не ответил за отведённое время.',
            advice: 'Проверь маршрут через VPN/прокси и повтори позже.',
        };
    }

    if (
        ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED'].includes(code) ||
        /fetch failed|network|connection closed/iu.test(lower)
    ) {
        return {
            kind: 'network',
            retryable: true,
            code: code || 'NETWORK',
            summary: 'Сетевое соединение с Telegram недоступно.',
            advice: 'Проверь VPN, прокси, брандмауэр и доступ к Telegram через браузер.',
        };
    }

    if (status >= 400) {
        return {
            kind: 'api-error',
            retryable: status >= 500,
            code: code || `HTTP_${status}`,
            summary: `Telegram Bot API вернул HTTP ${status}.`,
            advice: status >= 500
                ? 'Это может быть временный сбой Telegram; повтори позже.'
                : 'Проверь конфигурацию Telegram-бота.',
        };
    }

    return {
        kind: 'unknown',
        retryable: true,
        code: code || 'UNKNOWN',
        summary: message || 'Неизвестная ошибка подключения Telegram.',
        advice: 'Запусти встроенную проверку Telegram и посмотри результаты обоих сетевых адресов.',
    };
}

async function probeEndpoint({ name, url, fetchImpl, timeoutMs }) {
    const startedAt = Date.now();

    try {
        const response = await fetchImpl(url, {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.timeout(timeoutMs),
            headers: {
                'User-Agent': 'vk-ai-bot-telegram-diagnostic/1.0',
                Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
            },
        });

        try {
            await response.body?.cancel?.();
        } catch {
            // Диагностика не должна падать при закрытии тела ответа.
        }

        return {
            name,
            url,
            ok: true,
            status: response.status,
            latencyMs: Date.now() - startedAt,
            kind: 'http',
            code: `HTTP_${response.status}`,
            message: `HTTP ${response.status}`,
        };
    } catch (error) {
        const classified = classifyTelegramConnectionError(error);

        return {
            name,
            url,
            ok: false,
            status: 0,
            latencyMs: Date.now() - startedAt,
            kind: classified.kind,
            code: classified.code,
            message: classified.summary,
            advice: classified.advice,
        };
    }
}

export async function runTelegramConnectivityDiagnostics({
    fetchImpl = globalThis.fetch,
    timeoutMs = 10_000,
} = {}) {
    if (typeof fetchImpl !== 'function') {
        throw new TypeError('fetchImpl должен быть функцией.');
    }

    const probes = await Promise.all([
        probeEndpoint({
            name: 'Bot API',
            url: 'https://api.telegram.org',
            fetchImpl,
            timeoutMs,
        }),
        probeEndpoint({
            name: 'Telegram Web',
            url: 'https://t.me',
            fetchImpl,
            timeoutMs,
        }),
    ]);

    return {
        ok: probes.every((probe) => probe.ok),
        probes,
        checkedAt: new Date().toISOString(),
    };
}

export function formatTelegramConnectivityDiagnostics(result) {
    const lines = [
        `Сетевая диагностика Telegram: ${result?.ok ? 'успешно' : 'есть ошибки'}.`,
    ];

    for (const probe of result?.probes ?? []) {
        if (probe.ok) {
            lines.push(
                `• ${probe.name}: доступен, HTTP ${probe.status}, ${probe.latencyMs} мс.`,
            );
        } else {
            lines.push(
                `• ${probe.name}: недоступен, ${probe.code}; ${probe.message}`,
            );
        }
    }

    const advice = (result?.probes ?? [])
        .find((probe) => !probe.ok && probe.advice)
        ?.advice;

    if (advice) {
        lines.push(`Рекомендация: ${advice}`);
    }

    return lines.join('\n');
}
