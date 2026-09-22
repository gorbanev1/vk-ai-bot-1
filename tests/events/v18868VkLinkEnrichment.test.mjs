import assert from 'node:assert/strict';
import test from 'node:test';
import {
    attachVkChildSourceProvenance,
    boundedVkEventSourceLinks,
    classifyVkEventSourceUrl,
    validateResolvedVkShortUrl,
} from '../../src/features/events/vkEventLinkEnrichment.js';

test('bounded VK link whitelist excludes tickets/social/random external URLs', () => {
    const links = boundedVkEventSourceLinks([
        'https://vk.ru/wall-123_45',
        'https://vk.com/event777',
        'https://vk.ru/club888',
        'https://vk.cc/abc',
        'https://tickets.example/show',
        'https://t.me/channel/1',
    ]);
    assert.deepEqual(links.map((item) => item.kind), ['wall', 'event', 'community', 'short']);
    assert.equal(classifyVkEventSourceUrl('https://tickets.example/show').eligible, false);
});

test('short links are accepted only after resolving back to VK', () => {
    assert.equal(validateResolvedVkShortUrl('https://tickets.example/show'), null);
    assert.equal(validateResolvedVkShortUrl('https://vk.ru/wall-7_9')?.kind, 'wall');
});

test('schedule children get matching direct wall provenance without duplicate cards', () => {
    const events = [
        { title: 'SENAMIRHA', eventDate: '2026-10-11', venue: 'The Last of Vavilone' },
        { title: 'HELLO, СЕЛО', eventDate: '2026-10-18', venue: 'Diesel Hall' },
    ];
    const enriched = attachVkChildSourceProvenance(events, [
        { url: 'https://vk.ru/wall-240444315_7', context: '11/10 SENAMIRHA The Last of Vavilone' },
        { url: 'https://vk.ru/wall-100_1181', context: '18/10 HELLO, СЕЛО Diesel Hall' },
    ], { parentSourceUrl: 'https://vk.ru/wall-1_99', parentItemId: '99' });
    assert.equal(enriched.length, 2);
    assert.equal(enriched[0].canonicalPostUrl, 'https://vk.ru/wall-240444315_7');
    assert.equal(enriched[1].canonicalPostUrl, 'https://vk.ru/wall-100_1181');
    assert.equal(enriched[0].sourceOriginalUrl, 'https://vk.ru/wall-1_99');
    assert.equal(enriched[0].canonicalOrigin, 'schedule-child-link');
});

import { resolveVkShortUrlControlled } from '../../src/features/events/vkEventLinkEnrichment.js';

test('vk.cc resolver stops before requesting an external redirect target', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
        calls.push(String(url));
        return {
            status: 302,
            headers: { get(name) { return String(name).toLowerCase() === 'location' ? 'https://tickets.example/show' : ''; } },
        };
    };
    const resolved = await resolveVkShortUrlControlled('https://vk.cc/abc', { fetchImpl });
    assert.equal(resolved, null);
    assert.deepEqual(calls, ['https://vk.cc/abc']);
});

test('vk.cc resolver accepts a direct VK wall redirect in one bounded hop', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
        calls.push(String(url));
        return {
            status: 302,
            headers: { get(name) { return String(name).toLowerCase() === 'location' ? 'https://vk.com/wall-9_77' : ''; } },
        };
    };
    const resolved = await resolveVkShortUrlControlled('https://vk.cc/abc', { fetchImpl });
    assert.equal(resolved?.url, 'https://vk.ru/wall-9_77');
    assert.deepEqual(calls, ['https://vk.cc/abc']);
});
