import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { packCompactVkEventList } from '../../src/features/events/compactEventListMessages.js';

const source = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

function isolate(start, end, expression, globals) {
    const a = source.indexOf(start);
    const b = source.indexOf(end, a + start.length);
    assert.ok(a >= 0 && b > a, 'function boundaries exist: ' + start);
    return runInNewContext(source.slice(a, b).replace(/^export /u, '') + '\n' + expression, globals);
}

const promo = 'БОТ В ТГ — УДОБНЕЕ С КНОПОЧКАМИ: https://t.me/Gigorave_bot';

const compact = isolate(
    'function buildCompactPublicEventsMessage(items, range) {',
    '\nasync function sendCompactPublicEventList(',
    'buildCompactPublicEventsMessage',
    {
        COMPACT_EVENT_DIVIDER: '━━━━━━━━━━━━',
        compactPartyHeading: () => 'Тусы сегодня:',
        cleanVkEventText: (value, limit = 4096) => String(value || '').slice(0, limit),
        cleanEventTitle: value => value,
        stripKnownVenueNamesFromEventTitle: value => value,
        sharedEventDateLabel: () => '',
        getSharedEventSchedule: () => null,
        formatIsoEventDate: value => value,
        getCompactSupportedTime: event => event.eventTime,
        getDisplayEventVenue: event => event.venue,
        normalizeCompactSummary: value => value,
        buildLocalCompactPartySummary: event => event.description,
        buildCompactEventLinkLine: event => '🔗 ' + event.sourceUrl,
        buildEventCardLinkMarkup: value => ({ text: value, html: value }),
    },
);

const buildFullCard = isolate(
    "export function buildSinglePublicEventMessage(event, platform = '', announcementOverride = null) {",
    '\nfunction buildLinkedEventCardMessage(',
    'buildSinglePublicEventMessage',
    {
        cleanVkEventText: (value, limit = 4096) => String(value || '').slice(0, limit),
        cleanEventTitle: value => value,
        stripKnownVenueNamesFromEventTitle: value => value,
        sharedEventDateLabel: () => '',
        getSharedEventSchedule: () => null,
        formatIsoEventDate: value => value,
        buildPublicEventSourceBlock: event => 'Источник: ' + event.sourceUrl,
        getDisplayEventVenue: event => event.venue,
        formatEventMetadataTags: () => '',
        isUsefulEventTicketUrl: () => false,
        eventCalendarAvailability: () => false,
        PUBLIC_EVENT_CARD_NOTICE: '❗ УТОЧНЯЙТЕ ДЕТАЛИ',
        PUBLIC_EVENT_CARD_ACTIONS_GUIDE: '',
    },
);

const notice = isolate(
    'async function sendPublicEventAutomationNotice(',
    '\nfunction resolveEventImagePath(',
    'sendPublicEventAutomationNotice',
    {
        PARTY_POOL_PRIMARY: 'primary',
        getRawContext: context => context,
        publicSourcesReplyMarkup: pool => ({ inline_keyboard: [[{ text: pool }]] }),
        VK_TELEGRAM_BOT_PROMO_LINE: promo,
        PUBLIC_EVENT_AUTOMATION_NOTICE: '⚠️ АНОНСЫ СОБРАНЫ В АВТОМАТИЧЕСКОМ РЕЖИМЕ.',
    },
);

const items = count => Array.from({ length: count }, (_, index) => ({
    event: {
        id: index + 1,
        title: 'Концерт ' + (index + 1),
        eventDate: '2026-11-04',
        eventTime: '19:00',
        venue: 'Котельная',
        description: 'Живой концерт ' + (index + 1),
        sourceUrl: 'https://example.org/event/' + (index + 1),
    },
}));

test('short VK listing has visible separators and no repeated Telegram promo', () => {
    const message = compact(items(3), { kind: 'today' });
    assert.match(message, /^Тусы сегодня:\n\n1\. 🎸/u);
    assert.deepEqual([...message.matchAll(/^(\d+)\. 🎸/gmu)].map(match => Number(match[1])), [1, 2, 3]);
    assert.equal(message.split('━━━━━━━━━━━━').length - 1, 2);
    assert.doesNotMatch(message, /БОТ В ТГ|t\.me\/Gigorave_bot/u);
    assert.equal(packCompactVkEventList(message, 3500).join('\n\n'), message);
});

test('long VK short list retains all numbered events and separators after splitting', () => {
    const longItems = items(60).map(item => ({ event: { ...item.event, description: 'Анонс '.repeat(60) } }));
    const message = compact(longItems, { kind: 'today' });
    const chunks = packCompactVkEventList(message, 3500);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every(part => part.length <= 3500));
    assert.equal(chunks.join('\n\n'), message);
    assert.equal(message.split('━━━━━━━━━━━━').length - 1, 59);
    assert.equal([...message.matchAll(/^(\d+)\. 🎸/gmu)].length, 60);
    assert.doesNotMatch(message, /БОТ В ТГ/u);
});

test('full VK cards show details but keep promo out of each individual card', () => {
    const card = buildFullCard(items(1)[0].event, 'vk', 'Подробный анонс');
    assert.match(card, /Подробный анонс/u);
    assert.match(card, /УТОЧНЯЙТЕ ДЕТАЛИ/u);
    assert.doesNotMatch(card, /БОТ В ТГ|t\.me\/Gigorave_bot/u);
});

test('final automated notice includes promo once for full VK, never for compact VK', async () => {
    const sent = [];
    const ctx = { platform: 'vk', send: async data => sent.push(data.message) };
    await notice(ctx, 3, { includeTelegramPromo: false });
    assert.equal(sent.length, 1);
    assert.doesNotMatch(sent[0], /БОТ В ТГ|t\.me\/Gigorave_bot/u);
    await notice(ctx, 3);
    assert.equal(sent.length, 2);
    assert.match(sent[1], /АНОНСЫ СОБРАНЫ В АВТОМАТИЧЕСКОМ РЕЖИМЕ/u);
    assert.equal(sent[1].split(promo).length - 1, 1);
    await notice({ ...ctx, platform: 'telegram' }, 3);
    assert.equal(sent.length, 3);
    assert.doesNotMatch(sent[2], /БОТ В ТГ/u);
});

test('compact sender explicitly disables promo and separates Telegram cards too', () => {
    const a = source.indexOf('async function sendCompactPublicEventList(');
    const b = source.indexOf('\nconfigureEventAnnouncementCopies(', a);
    assert.ok(a >= 0 && b > a);
    const shortSender = source.slice(a, b);
    assert.match(shortSender, /includeTelegramPromo:\s*false/u);
    assert.ok(shortSender.includes('const prefix = index > 0 ?'));
    assert.ok(shortSender.includes('COMPACT_EVENT_DIVIDER'));
    assert.match(shortSender, /packCompactTelegramEventList/u);
});
