import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEventCardLinkMarkup, buildVkEventCardKeyboard, getEventCardLinkMarkupExpansion, getEventVenueLinkData } from '../../src/features/events/eventCardLinks.js';
import { mergeImportedEventVenues } from '../../src/features/events/eventVenueCatalog.js';

test('Telegram falls back to VK then website; VK name never links another platform', () => {
    mergeImportedEventVenues([
        { id: 'site-test', name: 'Ксенолитариум', address: 'ул. Примерная, 3', websiteUrl: 'https://venue.example/' },
        { id: 'vk-test', name: 'Ультрамариновый', address: 'ул. Примерная, 4', vkUrl: 'https://vk.com/ultramarin', websiteUrl: 'https://other.example/' },
        { id: 'tg-test', name: 'Хризолитовый', address: 'ул. Примерная, 5', telegramUrl: 'https://t.me/hrizolit' },
    ]);
    for (const [name, url] of [['Ксенолитариум', 'https://venue.example/'], ['Ультрамариновый', 'https://vk.com/ultramarin'], ['Хризолитовый', 'https://t.me/hrizolit']]) {
        const event = { venue: name };
        const text = '🎸 🎵 Кириллица & эмодзи\n\n📍 ' + getEventVenueLinkData(event).text;
        const tg = buildEventCardLinkMarkup(text, { event, platform: 'telegram' });
        assert.ok(tg.html.includes('<a href="' + url + '">' + name + '</a>, <a href="https://yandex.ru/maps/'));
        const vk = buildEventCardLinkMarkup(text, { event, platform: 'vk' });
        assert.equal(vk.text.includes('https://yandex'), false);
        assert.equal(vk.text.includes('https://venue.example'), false);
        assert.equal(vk.text.includes('https://t.me'), false);
        if (name === 'Ультрамариновый') assert.ok(vk.text.includes('[https://vk.com/ultramarin|Ультрамариновый], ул. Примерная, 4'));
    }
});

test('Telegram links the canonical name and the complete address separately', () => {
    const event = { sourceType: 'vk_public', sourceName: 'rb_diesel', venue: 'Дизель Холл, Лизюкова 8' };
    const venue = getEventVenueLinkData(event);
    assert.equal(venue.text, 'Diesel Hall, ул. Генерала Лизюкова, 4 ❓(Лизюкова 8)❓');
    const telegram = buildEventCardLinkMarkup('📍 ' + venue.text, { event, platform: 'telegram' });
    assert.ok(telegram.html.startsWith('📍 <a href="https://t.me/rb_diesel">Diesel Hall</a>, <a href="https://yandex.ru/maps/?text='));
    assert.ok(telegram.html.includes('>ул. Генерала Лизюкова, 4 ❓(Лизюкова 8)❓</a>'));
    assert.equal((telegram.html.match(/<a href=/gu) || []).length, 2);
    assert.deepEqual([...telegram.html.matchAll(/<a href="[^"]+">([^<]+)<\/a>/gu)].map(match => match[1]), ['Diesel Hall', 'ул. Генерала Лизюкова, 4 ❓(Лизюкова 8)❓']);
    const vk = buildEventCardLinkMarkup('📍 ' + venue.text, { event, platform: 'vk' });
    assert.ok(vk.text.includes('[https://vk.com/rb_diesel|Diesel Hall], ул. Генерала'));
    assert.equal(vk.text.includes('yandex.ru/maps'), false);
});

test('Telegram does not normalize a Krasnodar venue to a Voronezh catalog entry', () => {
    const event = { venue: 'The Rock Bar, ул. Горького, 104, Краснодар' };
    const venue = getEventVenueLinkData(event);
    assert.equal(venue.text, event.venue);
    const telegram = buildEventCardLinkMarkup('📍 ' + venue.text, { event, platform: 'telegram' });
    assert.equal(telegram.html.includes('vavilone_rb'), false);
    assert.match(telegram.html, /Горького, 104, Краснодар/u);
});

test('unknown venue stays intact', () => {
    const event = { venue: 'Клуб на улице Мира, 10' };
    assert.equal(getEventVenueLinkData(event).text, event.venue);
});

test('VK card keyboard keeps map link as a separate button', () => {
    const keyboard = JSON.parse(buildVkEventCardKeyboard({
        sourceType: 'vk_public', sourceName: 'rb_diesel', id: 42, eventDate: '2026-10-24',
        venue: 'Diesel Hall, ул. Генерала Лизюкова, 4',
    }, { calendarEndpoint: 'https://gigorave.tw1.ru/calendar.php', calendarSecret: 'test-secret' }));
    const actions = keyboard.buttons.flat().map(row => row.action);
    assert.ok(actions.some(action => action.type === 'open_link' && action.label.includes('Источник')));
    assert.ok(actions.some(action => action.type === 'open_link' && action.label.includes('Яндекс')));
    assert.ok(actions.some(action => action.type === 'callback' && JSON.parse(action.payload).action === 'event_remind'));
    assert.ok(actions.some(action => action.type === 'callback' && JSON.parse(action.payload).action === 'event_remind_group'));
    const calendar = actions.find(action => action.type === 'open_link' && action.label.includes('календарь'));
    assert.ok(calendar);
    const calendarUrl = new URL(calendar.link);
    assert.equal(calendarUrl.origin + calendarUrl.pathname, 'https://gigorave.tw1.ru/calendar.php');
    assert.equal(calendarUrl.searchParams.get('open'), 'options');
    assert.equal(calendarUrl.searchParams.has('e'), true);
});

test('VK calendar button is omitted without a configured hosted options page', () => {
    const keyboard = JSON.parse(buildVkEventCardKeyboard({
        sourceType: 'vk_public', sourceName: 'rb_diesel', id: 42, eventDate: '2026-10-24',
        venue: 'Diesel Hall, ул. Генерала Лизюкова, 4',
    }));
    const actions = keyboard.buttons.flat().map(row => row.action);
    assert.equal(actions.some(action => action.type === 'open_link' && action.label.includes('календарь')), false);
    assert.equal(actions.some(action => /calendar\.google\.com/u.test(action.link || '')), false);
});

test('VK markup expansion counts only the name link', () => {
    const event = { sourceType: 'vk_public', sourceName: 'rb_diesel', venue: 'Diesel Hall, ул. Генерала Лизюкова, 4' };
    const venue = getEventVenueLinkData(event).text;
    const linked = buildEventCardLinkMarkup('📍 ' + venue, { event, venue, platform: 'vk' });
    assert.equal(linked.text.length - ('📍 ' + venue).length, getEventCardLinkMarkupExpansion(event, 'vk'));
});
