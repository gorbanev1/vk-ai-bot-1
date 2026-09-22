/**
 * V152: нормализация и долговечный owner-registry публичных источников афиши.
 *
 * Хранилище само находится в SQLite maintenance_state (оркестратор отвечает
 * за чтение/запись), а этот модуль остаётся чистым и тестируемым: распознаёт
 * Telegram/VK-ссылки, строит стабильный source-id и сливает конфигурации без
 * дублей.
 */
import { clampInteger } from '../../shared/numbers.js';

const TELEGRAM_HOSTS = new Set([
    't.me',
    'telegram.me',
    'www.t.me',
    'www.telegram.me',
]);

const VK_HOSTS = new Set([
    'vk.com',
    'vk.ru',
    'www.vk.com',
    'www.vk.ru',
    'm.vk.com',
    'm.vk.ru',
]);

function cleanToken(value) {
    return String(value ?? '')
        .trim()
        .replace(/^[<\[(]+/u, '')
        .replace(/[>\]),.;!?]+$/u, '')
        .trim();
}

function normalizeTelegramSource(value) {
    const source = String(value ?? '')
        .trim()
        .replace(/^@+/u, '')
        .toLowerCase();

    if (!/^[a-z0-9_]{4,64}$/u.test(source)) return '';
    return source;
}

function normalizeVkSource(value) {
    const source = String(value ?? '')
        .trim()
        .replace(/^@+/u, '')
        .toLowerCase();

    if (!/^[a-z0-9_.-]{2,128}$/u.test(source)) return '';
    return source;
}

function buildTelegramDescriptor(source, initialCount = 20) {
    const channel = normalizeTelegramSource(source);
    if (!channel) return null;

    return {
        kind: 'telegram',
        source: channel,
        id: `tg:${channel}`,
        label: `Telegram @${channel}`,
        url: `https://t.me/s/${channel}`,
        initialCount: clampInteger(initialCount, 1, 20, 20),
    };
}

function buildVkDescriptor(source, initialCount = 20) {
    const screenName = normalizeVkSource(source);
    if (!screenName) return null;

    return {
        kind: 'vk-public',
        source: screenName,
        id: `vk:${screenName}`,
        label: `VK vk.ru/${screenName}`,
        url: `https://vk.ru/${screenName}`,
        initialCount: clampInteger(initialCount, 1, 20, 20),
    };
}

function parseTelegramUrl(url) {
    const parts = url.pathname
        .split('/')
        .map((part) => decodeURIComponent(part).trim())
        .filter(Boolean);

    if (parts[0]?.toLowerCase() === 's') parts.shift();
    const candidate = String(parts[0] ?? '').trim();

    if (!candidate || /^(?:joinchat|c)$/iu.test(candidate) || candidate.startsWith('+')) {
        return null;
    }

    return buildTelegramDescriptor(candidate);
}

function parseVkUrl(url) {
    const parts = url.pathname
        .split('/')
        .map((part) => decodeURIComponent(part).trim())
        .filter(Boolean);
    const first = String(parts[0] ?? '').trim();

    if (!first || /^(?:im|feed|groups|friends|login|video|clips|market|search)$/iu.test(first)) {
        return null;
    }

    // Ссылка на конкретный пост группы: wall-95062430_2705 -> club95062430.
    // Это позволяет владельцу просто переслать URL поста, не выясняя screen_name.
    const wall = first.match(/^wall-(\d+)_\d+$/iu);
    if (wall) {
        return buildVkDescriptor(`club${wall[1]}`);
    }

    // wall123_456 — стена пользователя, а public scraper предназначен для
    // пабликов/сообществ; не принимаем её молча как источник афиши.
    if (/^wall\d+_\d+$/iu.test(first)) return null;

    return buildVkDescriptor(first);
}

/**
 * Принимает одну публичную ссылку/идентификатор:
 *   https://t.me/channel, https://t.me/s/channel/123, @channel, tg:channel
 *   https://vk.com/screen, https://vk.ru/wall-123_456, vk:screen
 */
export function parseManualScraperSource(value) {
    const raw = cleanToken(value);
    if (!raw) {
        return {
            ok: false,
            error: 'Пришли ссылку на публичный Telegram-канал или VK-сообщество.',
        };
    }

    const prefixedTelegram = raw.match(/^(?:tg|telegram):\s*@?([^\s]+)$/iu);
    if (prefixedTelegram) {
        const descriptor = buildTelegramDescriptor(prefixedTelegram[1]);
        return descriptor
            ? { ok: true, source: descriptor }
            : { ok: false, error: 'Не понял идентификатор Telegram-канала.' };
    }

    const prefixedVk = raw.match(/^vk:\s*@?([^\s]+)$/iu);
    if (prefixedVk) {
        const descriptor = buildVkDescriptor(prefixedVk[1]);
        return descriptor
            ? { ok: true, source: descriptor }
            : { ok: false, error: 'Не понял идентификатор VK-сообщества.' };
    }

    if (/^@[a-z0-9_]{4,64}$/iu.test(raw)) {
        return { ok: true, source: buildTelegramDescriptor(raw) };
    }

    let candidate = raw;
    if (/^(?:t\.me|telegram\.me|vk\.com|vk\.ru)\//iu.test(candidate)) {
        candidate = `https://${candidate}`;
    }

    try {
        const url = new URL(candidate);
        const host = url.hostname.toLowerCase();
        if (TELEGRAM_HOSTS.has(host)) {
            const descriptor = parseTelegramUrl(url);
            return descriptor
                ? { ok: true, source: descriptor }
                : {
                    ok: false,
                    error: 'Нужна публичная ссылка Telegram вида https://t.me/channel. Приватные invite/c-ссылки не подходят.',
                };
        }

        if (VK_HOSTS.has(host)) {
            const descriptor = parseVkUrl(url);
            return descriptor
                ? { ok: true, source: descriptor }
                : {
                    ok: false,
                    error: 'Нужна ссылка на VK-сообщество или пост сообщества.',
                };
        }
    } catch {
        // Ниже вернём единое понятное сообщение.
    }

    return {
        ok: false,
        error: 'Не понял источник. Пришли https://t.me/channel, @channel, https://vk.ru/community или vk:community.',
    };
}

export function normalizePersistedManualScraperSources(value) {
    if (!Array.isArray(value)) return [];

    const result = [];
    const seen = new Set();

    for (const item of value) {
        const kind = String(item?.kind ?? '').trim().toLowerCase();
        const descriptor = kind === 'telegram'
            ? buildTelegramDescriptor(item?.source, item?.initialCount)
            : kind === 'vk-public'
                ? buildVkDescriptor(item?.source, item?.initialCount)
                : null;
        if (!descriptor || seen.has(descriptor.id)) continue;
        seen.add(descriptor.id);
        result.push({
            ...descriptor,
            addedAt: Number(item?.addedAt ?? 0) || 0,
        });
    }

    return result;
}

export function mergeSourceConfigurations(base = [], extras = []) {
    const result = [];
    const seen = new Set();

    for (const configuration of [...base, ...extras]) {
        const source = String(configuration?.source ?? '').trim();
        if (!source) continue;
        const key = source.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({
            source,
            initialCount: clampInteger(configuration?.initialCount, 1, 20, 20),
        });
    }

    return result;
}
