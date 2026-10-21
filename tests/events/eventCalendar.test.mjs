import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildHostedCalendarUrl,
    buildAppleCalendarLinks,
    buildEventCalendarLinks,
    buildEventCalendarIcs,
    eventCalendarAvailability,
    eventCalendarFilename,
} from '../../src/features/events/eventCalendar.js';

test('calendar export creates an RFC 5545 event with a default one-day reminder', () => {
    const event = {
        id: 51,
        sourceType: 'vk',
        title: 'Existenter, ШРАМЫ',
        eventDate: '2026-11-14',
        eventTime: '20:00',
        venue: 'Последний Вавилон, Воронеж',
        sourceUrl: 'https://vk.ru/wall-227219886_138',
        announcement: 'Концерт в поддержку альбома',
    };
    const data = buildEventCalendarIcs(event, { now: new Date('2026-10-16T00:00:00.000Z') });
    const ics = data.toString('utf8');
    assert.equal(eventCalendarAvailability(event), true);
    assert.match(ics, /BEGIN:VCALENDAR\r\nVERSION:2\.0/u);
    assert.doesNotMatch(ics, /METHOD:/u);
    assert.match(ics, /DTSTART:20261114T170000Z/u);
    assert.match(ics, /DTEND:20261114T190000Z/u);
    assert.doesNotMatch(ics, /TZID=/u);
    assert.match(ics, /SUMMARY:Existenter\\, ШРАМЫ/u);
    assert.match(ics, /TRIGGER:-P1D\r\nEND:VALARM/u);
    assert.match(ics, /BEGIN:VALARM\r\nUID:gigorave-vk-51-alarm-1@gigorave\r\nX-WR-ALARMUID:gigorave-vk-51-alarm-1@gigorave\r\nACTION:DISPLAY/u);
    assert.equal((ics.match(/BEGIN:VALARM\r\n/gu) || []).length, 1);
    assert.match(ics, /DESCRIPTION:Напоминание за день/u);
    assert.doesNotMatch(ics, /TRIGGER:-PT1H/u);
    assert.match(ics, /URL:https:\/\/vk\.ru\/wall-227219886_138/u);
    assert.match(eventCalendarFilename(event), /Existenter-ШРАМЫ\.ics/u);
});

test('calendar deep links open prefilled Google and Outlook events with the event time zone', () => {
    const event = {
        title: 'Existenter, ШРАМЫ',
        eventDate: '2026-11-14',
        eventTime: '20:00',
        venue: 'Последний Вавилон, Воронеж',
        sourceUrl: 'https://vk.ru/wall-227219886_138',
        description: 'Концерт в поддержку альбома',
    };
    const links = buildEventCalendarLinks(event, { timeZone: 'Europe/Moscow' });
    const google = new URL(links.google);
    const outlook = new URL(links.outlook);
    const googleDates = new URLSearchParams(google.search).get('dates');
    assert.equal(google.hostname, 'calendar.google.com');
    assert.equal(google.searchParams.get('action'), 'TEMPLATE');
    assert.equal(google.searchParams.get('ctz'), 'Europe/Moscow');
    assert.equal(googleDates, '20261114T170000Z/20261114T190000Z');
    assert.equal(google.searchParams.get('location'), event.venue);
    assert.equal(outlook.hostname, 'outlook.live.com');
    assert.equal(outlook.searchParams.get('subject'), event.title);
    assert.equal(outlook.searchParams.get('startdt'), '2026-11-14T17:00:00.000Z');
    assert.equal(outlook.searchParams.get('enddt'), '2026-11-14T19:00:00.000Z');
    assert.equal(outlook.searchParams.get('location'), event.venue);
});

test('calendar export accepts date-only events and rejects invalid dates', () => {
    assert.equal(eventCalendarAvailability({ eventDate: '2026-10-18' }), true);
    assert.equal(eventCalendarAvailability({ eventDate: 'unknown' }), false);
    assert.equal(buildEventCalendarIcs({ eventDate: 'unknown' }), null);
    const dateOnlyIcs = buildEventCalendarIcs({ eventDate: '2026-10-18', title: 'All day' }).toString('utf8');
    assert.match(dateOnlyIcs, /DTSTART;VALUE=DATE:20261018/u);
    assert.match(dateOnlyIcs, /TRIGGER:-P1D/u);
});

test('hosted phone calendar link is HTTPS-only and HMAC signed', () => {
    const event = {
        title: 'Existenter', eventDate: '2026-11-14', eventTime: '20:00',
        venue: 'Последний Вавилон', sourceUrl: 'https://vk.ru/wall-1_2',
    };
    assert.equal(buildHostedCalendarUrl(event, { endpoint: 'http://example.com/calendar.php', secret: 'secret' }), '');
    assert.equal(buildHostedCalendarUrl(event, { endpoint: 'https://example.com/calendar.php' }), '');
    const url = new URL(buildHostedCalendarUrl(event, {
        endpoint: 'https://example.com/calendar.php', secret: 'shared secret',
    }));
    const payload = JSON.parse(Buffer.from(url.searchParams.get('e'), 'base64url').toString('utf8'));
    assert.equal(url.pathname, '/calendar.php');
    assert.equal(url.searchParams.has('v'), false);
    assert.equal(payload.t, 'Existenter');
    assert.equal(payload.d, '20261114');
    assert.equal(payload.tm, '2000');
    assert.equal(payload.v, 'Последний Вавилон');
    assert.equal(payload.u, 'https://vk.ru/wall-1_2');
    assert.equal(Object.hasOwn(payload, 'a'), false);
    assert.match(url.searchParams.get('s'), /^[a-f0-9]{64}$/u);
    const download = new URL(buildHostedCalendarUrl(event, {
        endpoint: 'https://example.com/calendar.php', secret: 'shared secret', download: true,
    }));
    assert.equal(download.searchParams.get('file'), 'ics');
    assert.equal(download.searchParams.get('e'), url.searchParams.get('e'));
    assert.equal(download.searchParams.get('s'), url.searchParams.get('s'));
    const appleLinks = buildAppleCalendarLinks(event, {
        endpoint: 'https://example.com/calendar.php', secret: 'shared secret',
    });
    const subscribePage = new URL(appleLinks.subscribe);
    assert.equal(subscribePage.searchParams.get('open'), 'webcal');
    assert.equal(subscribePage.searchParams.get('e'), url.searchParams.get('e'));
    assert.equal(subscribePage.searchParams.get('s'), url.searchParams.get('s'));
    const optionsPage = new URL(appleLinks.options);
    assert.equal(optionsPage.searchParams.get('open'), 'options');
    assert.equal(optionsPage.searchParams.get('e'), url.searchParams.get('e'));
    assert.equal(optionsPage.searchParams.get('s'), url.searchParams.get('s'));
});

test('calendar options link keeps inline markup comfortably below Telegram size limits', () => {
    const event = {
        title: 'Событие '.repeat(25),
        eventDate: '2026-11-14',
        eventTime: '20:00',
        venue: 'Площадка '.repeat(25),
        sourceUrl: 'https://vk.ru/wall-123456789_987654321',
        announcement: 'Текст анонса '.repeat(100),
    };
    const options = { endpoint: 'https://gigorave.tw1.ru/calendar.php', secret: 'shared secret' };
    const links = buildAppleCalendarLinks(event, options);
    assert.ok(links.subscribe);
    assert.ok(links.options);
    assert.notEqual(links.subscribe, links.options);
    assert.ok(links.options.length < 2048);
    const replyMarkup = { inline_keyboard: [[{ text: '📅 Добавить в календарь', url: links.options }]] };
    assert.ok(Buffer.byteLength(JSON.stringify(replyMarkup), 'utf8') < 8192);
});
