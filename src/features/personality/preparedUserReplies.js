import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const PREPARED_USER_REPLIES_CONFIG_PATH = resolve(
    PROJECT_ROOT,
    'config/prepared-user-replies.json',
);

export function emptyPreparedUserRepliesConfig() {
    return { version: 1, users: [] };
}

export function normalizePreparedUserRepliesConfig(value) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.users)) {
        throw new TypeError('Config must be an object with a users array.');
    }

    const users = [];
    const seen = new Set();
    for (const entry of value.users) {
        if (!entry || typeof entry !== 'object') continue;
        const platform = String(entry.platform ?? '*').trim().toLowerCase() || '*';
        if (!['*', 'vk', 'telegram'].includes(platform)) continue;
        const ids = (Array.isArray(entry.ids) ? entry.ids : entry.id == null ? [] : [entry.id])
            .map((item) => String(item ?? '').trim())
            .filter(Boolean);
        const usernames = (Array.isArray(entry.usernames) ? entry.usernames : entry.username ? [entry.username] : [])
            .map((item) => String(item ?? '').trim().replace(/^@/u, '').toLowerCase())
            .filter(Boolean);
        const names = (Array.isArray(entry.names) ? entry.names : entry.name ? [entry.name] : [])
            .map((item) => String(item ?? '').trim().replace(/\s+/gu, ' ').toLowerCase())
            .filter(Boolean);
        const key = `${platform}:${ids.join(',')}:${usernames.join(',')}:${names.join(',')}`;
        if (seen.has(key) || (!ids.length && !usernames.length && !names.length)) continue;
        seen.add(key);

        const min = Math.max(0, Math.min(100_000, Math.trunc(Number(entry.interval?.min ?? 0) || 0)));
        const max = Math.max(min, Math.min(100_000, Math.trunc(Number(entry.interval?.max ?? min) || 0)));
        const phrases = (Array.isArray(entry.phrases) ? entry.phrases : [])
            .map((item) => String(item ?? '').trim())
            .filter(Boolean);
        if (!phrases.length) continue;
        users.push({ platform, ids, usernames, names, interval: { min, max }, phrases });
    }
    return { version: 1, users };
}

export function loadPreparedUserRepliesConfig(path = PREPARED_USER_REPLIES_CONFIG_PATH) {
    if (!existsSync(path)) return emptyPreparedUserRepliesConfig();
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return normalizePreparedUserRepliesConfig(parsed);
}

export function findPreparedUserReplyProfile(config, identity = {}) {
    const platform = String(identity.platform ?? '').trim().toLowerCase();
    const id = String(identity.id ?? '').trim();
    const username = String(identity.username ?? '').trim().replace(/^@/u, '').toLowerCase();
    const names = new Set((Array.isArray(identity.names) ? identity.names : [identity.name])
        .map((item) => String(item ?? '').trim().replace(/\s+/gu, ' ').toLowerCase())
        .filter(Boolean));

    return (config?.users ?? []).find((profile) => (
        (profile.platform === '*' || profile.platform === platform) &&
        ((id && profile.ids.includes(id)) ||
            (username && profile.usernames.includes(username)) ||
            [...names].some((name) => profile.names.includes(name)))
    )) || null;
}

export function pickPreparedUserReply(profile, randomInt = (min, max) => min + Math.floor(Math.random() * (max - min))) {
    const phrases = Array.isArray(profile?.phrases) ? profile.phrases.filter((item) => String(item ?? '').trim()) : [];
    if (!phrases.length) return '';
    return phrases[randomInt(0, phrases.length)] || phrases[0];
}

export function formatPreparedUserReply(phrase, identity = {}) {
    const name = String(identity.name ?? '').replace(/[\r\n]+/gu, ' ').trim();
    const username = String(identity.username ?? '').trim().replace(/^@/u, '');
    const mention = identity.platform === 'vk' && identity.id
        ? `[id${identity.id}|${name || `id${identity.id}`}]`
        : username ? `@${username}` : name;
    return String(phrase ?? '')
        .replaceAll('{name}', name)
        .replaceAll('{username}', username)
        .replaceAll('{mention}', mention)
        .trim();
}

export function advancePreparedUserReplyCounter(state, interval, randomInt = (min, max) => min + Math.floor(Math.random() * (max - min))) {
    const min = Math.max(0, Math.trunc(Number(interval?.min) || 0));
    const max = Math.max(min, Math.trunc(Number(interval?.max) || 0));
    const totalRequests = Math.max(0, Math.trunc(Number(state?.totalRequests) || 0)) + 1;
    let nextReplyAt = Math.max(0, Math.trunc(Number(state?.nextReplyAt) || 0));

    if (!nextReplyAt || Number(state?.intervalMin) !== min || Number(state?.intervalMax) !== max) {
        nextReplyAt = totalRequests + randomInt(min, max + 1);
    }
    if (totalRequests < nextReplyAt) {
        return { shouldReply: false, state: { totalRequests, nextReplyAt, intervalMin: min, intervalMax: max } };
    }

    const nextGap = randomInt(min, max + 1);
    return {
        shouldReply: true,
        state: { totalRequests, nextReplyAt: totalRequests + nextGap, intervalMin: min, intervalMax: max },
    };
}

export function parsePreparedUserRepliesReloadCommand(value) {
    const normalized = String(value ?? '').trim().toLowerCase().replace(/ё/gu, 'е').replace(/\s+/gu, ' ');
    return /^(?:подгрузить|перечитать|обновить) фраз(?:ы|ы для юзернеймов|ы пользователей)(?: для юзернеймов)?$/u.test(normalized) ||
        /^(?:подгрузить|перечитать|обновить) фразы$/u.test(normalized);
}
