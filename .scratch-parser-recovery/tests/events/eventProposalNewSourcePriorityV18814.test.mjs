import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { extractEventProposalRestartSource } from '../../src/features/events/eventProposalWorkflow.js';
import { parsePublicPostLocally } from '../../src/features/events/publicPostLocalParser.js';

const appSource = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

test('V188.14 a fresh VK/Telegram source link escapes pending draft-edit state', () => {
    const vk = extractEventProposalRestartSource('https://vk.ru/wall-240648015_4');
    assert.equal(vk?.descriptor?.platform, 'vk');
    assert.equal(vk?.descriptor?.kind, 'exact-post');

    const prefixed = extractEventProposalRestartSource('предложить информацию о тусе https://vk.ru/wall-240648015_4');
    assert.equal(prefixed?.url, 'https://vk.ru/wall-240648015_4');

    const telegram = extractEventProposalRestartSource('https://t.me/example/123');
    assert.equal(telegram?.descriptor?.platform, 'telegram');

    const standaloneGeneric = extractEventProposalRestartSource('https://example.org/event/42');
    assert.equal(standaloneGeneric?.reason, 'standalone-http-link');
});

test('V188.14 correction containing a generic URL is not blindly treated as a new proposal', () => {
    assert.equal(
        extractEventProposalRestartSource('место: https://maps.example.org/venue'),
        null,
    );
});

test('V188.14 restart routing executes before pending review corrections', () => {
    const restartPos = appSource.indexOf('extractEventProposalRestartSource(commandText)');
    const reviewPos = appSource.indexOf("if (pending.mode === 'review')", restartPos);
    assert.ok(restartPos > 0);
    assert.ok(reviewPos > restartPos);

    const block = appSource.slice(restartPos - 500, reviewPos);
    assert.match(block, /EVENT PROPOSAL NEW SOURCE RESTART/u);
    assert.match(block, /mode: 'awaiting-input'/u);
    assert.match(block, /return handleEventProposalSubmission\(context, restartSubmission\)/u);
});

test('V188.14 Diesel Bar post resolves venue, date, start time and price locally', () => {
    const text = [
        'NO PLACE FOR OLD PADS',
        'Авторская ритмичная электронная музыка в тяжелых стилях с музыкантами, проверенными временем',
        'ГДЕ: DIESEL Bar, ул. Лизюкова, 4',
        'КОГДА: 19 сентября, двери 18:30, начало 19:00',
        'СКОЛЬКО: 500 рублей',
    ].join('\n');
    const [event] = parsePublicPostLocally({
        text,
        publishedAt: Math.floor(new Date('2026-08-19T12:00:00+03:00').getTime() / 1000),
    });
    assert.ok(event);
    assert.equal(event.eventDate, '2026-09-19');
    assert.equal(event.eventTime, '19:00');
    assert.equal(event.venue, 'DIESEL Bar, ул. Лизюкова, 4');
    assert.equal(event.price, '500 рублей');
});

test('V188.14 semantic venue audit uses poster facts and respects is_event=false', () => {
    assert.match(appSource, /posterFacts/u);
    assert.match(appSource, /isEventAnnouncement = parsed\?\.is_event !== false/u);
    assert.match(appSource, /decisions = isEventAnnouncement && Array\.isArray\(parsed\?\.events\)/u);
});
