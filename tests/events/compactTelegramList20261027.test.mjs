import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { packCompactTelegramEventList, packCompactVkEventList } from '../../src/features/events/compactEventListMessages.js';
import { inferEventSearchTags, eventTagLabel } from '../../src/features/events/eventSearchTaxonomy.js';
import { buildEventCardLinkMarkup, getEventVenueLinkData, getDisplayEventVenue } from '../../src/features/events/eventCardLinks.js';

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const section = app.slice(app.indexOf('function compactPartyHeading('), app.indexOf('\nconfigureEventAnnouncementCopies('));
const notices = [];
const sendList = runInNewContext(section + '\nsendCompactPublicEventList', {
    packCompactTelegramEventList, packCompactVkEventList, buildEventCardLinkMarkup, getEventVenueLinkData, getDisplayEventVenue,
    inferEventSearchTags, eventTagLabel,
    cleanVkEventText: (s, n) => String(s || '').slice(0, n),
    cleanEventTitle: s => s, stripKnownVenueNamesFromEventTitle: s => s,
    sharedEventDateLabel: () => '', formatIsoEventDate: s => s, getSharedEventSchedule: () => null,
    getCompactSupportedTime: e => e.eventTime, normalizeCompactSummary: s => s,
    buildLocalCompactPartySummary: e => e.description, getCompactPartySummaryBudget: () => 360,
    isUsefulEventTicketUrl: () => false, isQticketsListingRootUrl: () => false,
    isQticketsEventDetailUrl: () => false, isCompactSummaryUsable: s => !!s,
    summarizePublicEventsCompactWithMini: async events => events.map(e => ({compactSummary: e.description})),
    getRawContext: c => c, guardPartyContext: c => c, partyRequestStopped: () => false,
    partyDeliveryEventKey: e => String(e?.id || ''), VK_MESSAGE_SIZE: 3500,
    getDisplayEventVenue: e => e.venue,
    sendLong: async (c, text) => c.send(text),
    sendPublicEventAutomationNotice: async (...args) => notices.push(args),
    PARTY_POOL_PRIMARY: 'primary', VK_TELEGRAM_BOT_PROMO_LINE: 'VK promo',
    COMPACT_EVENT_DIVIDER: '━━━━━━━━━━━━',
    console: { log() {} },
});
const items = (count, summaryLength = 60) => Array.from({length: count}, (_, i) => ({
    event: { id: i + 1, title: 'Концерт ' + (i + 1), eventDate: '2026-10-30', eventTime: '20:00',
        venue: 'Liverpool Pub, ул. Куколкина, 33А/2', description: 'А & Б <рок> 🎸 ' + 'я'.repeat(summaryLength),
        sourceUrl: 'https://vk.ru/wall-95062430_' + (i + 1) },
}));
async function deliver(list, partyPool = 'secondary', platform = 'telegram') {
    const sent = [];
    const result = await sendList({platform, send: async payload => sent.push(payload)}, list, {kind: 'all'}, {partyPool});
    return {sent, result};
}

test('short Telegram list uses one message, one heading and consecutive numbers for every pool', async () => {
    for (const pool of ['primary', 'secondary', 'qtickets', 'all']) {
        const before = notices.length;
        const {sent, result} = await deliver(items(3), pool);
        assert.equal(sent.length, 1);
        assert.equal(result.sentCount, 3);
        assert.equal(notices.length, before + 1);
        assert.deepEqual([...sent[0].message.matchAll(/^(\d+)\. 🎸/gm)].map(m => +m[1]), [1, 2, 3]);
        assert.equal(sent[0].message.split('Все будущие тусы:').length - 1, 1);
        assert.ok(sent[0].html.includes('https://yandex.ru/maps/'));
        assert.ok(sent[0].html.includes('https://t.me/liverpoolgerold'));
        assert.ok(sent[0].html.includes('&amp; Б &lt;рок&gt;'));
        for (const item of items(3)) assert.ok(sent[0].html.includes(item.event.sourceUrl));
        assert.equal(sent[0].replyMarkup, undefined);
        assert.ok(!sent[0].message.includes('VK promo'));
    }
});

test('ten long entries split only at message capacity, without losing links or resetting numbering', async () => {
    const {sent} = await deliver(items(10, 340));
    assert.equal(sent.length, 2);
    const all = sent.map(p => p.message).join('\n\n');
    assert.deepEqual([...all.matchAll(/^(\d+)\. 🎸/gm)].map(m => +m[1]), [1,2,3,4,5,6,7,8,9,10]);
    assert.equal(all.split('Все будущие тусы:').length - 1, 1);
    for (const part of sent) {
        assert.ok(part.message.length <= 4096);
        assert.equal((part.html.match(/<a /g) || []).length, (part.html.match(/<\/a>/g) || []).length);
    }
    for (const item of items(10)) assert.ok(all.includes(item.event.sourceUrl));
});

test('oversized entry keeps its content, valid markup and intact emoji', () => {
    const event = items(1)[0].event;
    const text = '1. 🎸 Концерт\n📍 ' + event.venue + '\n' + '🎸 & <рок> '.repeat(1000);
    const card = {...buildEventCardLinkMarkup(text, {event, platform:'telegram'}), event};
    const messages = packCompactTelegramEventList([card], 'Все будущие тусы:');
    assert.ok(messages.length > 1);
    const joined = messages.map(p => p.text).join('').replace('Все будущие тусы:', '').replace(/\s/g, '');
    assert.equal(joined, text.replace(/\s/g, ''));
    for (const part of messages) {
        assert.ok(part.text.length <= 4096);
        assert.ok(!/[\uD800-\uDBFF]$/.test(part.text));
        assert.ok(!/^[\uDC00-\uDFFF]/.test(part.text));
        assert.ok(!part.html.includes('<рок>'));
    }
    assert.deepEqual(packCompactTelegramEventList([], 'Heading'), []);
});

test('VK compact delivery remains one combined list', async () => {
    const {sent} = await deliver(items(3), 'secondary', 'vk');
    assert.equal(sent.length, 1);
    assert.equal(typeof sent[0].message, 'string');
    assert.match(sent[0].message, /3\. 🎸/);
    assert.equal((sent[0].message.match(/━━━━━━━━━━━━/gu) || []).length, 2);
    assert.doesNotMatch(sent[0].message, /БОТ В ТГ|VK promo/u);
});
