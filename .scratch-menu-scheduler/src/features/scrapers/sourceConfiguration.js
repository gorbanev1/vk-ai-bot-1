/**
 * Чистый разбор списков источников из .env с безопасными ограничениями объёма первого прохода.
 */
import { clampInteger } from '../../shared/numbers.js';

/**
 * Разбирает список источников вида `name:count,name2:count`.
 * Значение count ограничивается, чтобы ошибка в .env не заставила скрейпер
 * читать тысячи страниц за один запуск.
 */
export function parseSourceCountList(value, defaults = []) {
    const source = String(value ?? '').trim();
    const entries = source ? source.split(/[,;\n]+/u) : defaults;

    return entries
        .map((entry) => String(entry ?? '').trim())
        .filter(Boolean)
        .map((entry) => {
            const match = entry.match(/^(.*?)(?::(\d+))?$/u);
            return {
                source: String(match?.[1] ?? entry).trim(),
                initialCount: clampInteger(match?.[2], 1, 20, 20),
            };
        });
}

/**
 * Разбирает конфигурацию VK-бесед:
 * `Название|https://vk.ru/im?sel=c1|300|25`.
 *
 * Четвёртое поле включает history-backfill и задаёт желаемое число старых
 * сообщений. Любое положительное значение означает минимум 50 реально более
 * старых CMID; 0 выключает history-backfill. Исторический peer=2000000022 без
 * четвёртого поля по-прежнему мигрируется на 50 только здесь, в конфигурации;
 * сам parser не содержит peer-specific веток.
 */
export function parseVkChatConfigurations(value) {
    const defaults = [
        'Беседа 22|https://vk.ru/im?sel=c22|300|50',
        'Беседа 3|https://vk.ru/im?sel=c3|300|0',
        'Беседа 14|https://vk.ru/im?sel=c14|300|0',
    ];
    const entries = String(value ?? '').trim()
        ? String(value).split(/[;\n]+/u)
        : defaults;

    return entries
        .map((entry) => String(entry ?? '').trim())
        .filter(Boolean)
        .map((entry) => {
            const [name, url, initial, autoScroll] = entry.split('|');
            const cleanUrl = String(url ?? '').trim();
            const stableMatch = cleanUrl.match(/[?&]sel=c(\d+)/iu);
            const legacyMatch = cleanUrl.match(/\/im\/convo\/(\d+)/iu);
            const rawNumber = Number(stableMatch?.[1] ?? legacyMatch?.[1] ?? 0);
            const chatId = stableMatch
                ? rawNumber
                : rawNumber >= 2_000_000_000
                    ? rawNumber - 2_000_000_000
                    : rawNumber;
            const peerId = chatId > 0 ? 2_000_000_000 + chatId : 0;
            const normalizedUrl = chatId > 0
                ? `https://vk.ru/im?sel=c${chatId}`
                : cleanUrl;
            const defaultAutoScrollMessages = peerId === 2000000022 ? 50 : 0;
            const parsedAutoScrollMessages = clampInteger(
                autoScroll,
                0,
                500,
                defaultAutoScrollMessages,
            );
            return {
                name: String(name ?? '').trim(),
                url: normalizedUrl,
                initialMessages: clampInteger(initial, 20, 5000, 300),
                // Generic policy: once history-backfill is enabled for any
                // chat, it means at least fifty genuinely older messages.
                autoScrollMessages: parsedAutoScrollMessages > 0
                    ? Math.max(50, parsedAutoScrollMessages)
                    : 0,
            };
        })
        .filter((item) => item.url);
}
