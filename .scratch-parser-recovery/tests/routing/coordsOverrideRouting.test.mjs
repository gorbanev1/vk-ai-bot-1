import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
    getCoordsOverrideWindowState,
    isCoordsOverrideWindow,
    parseCoordsOverrideCommand,
    shouldSendCoordsOverride,
} from '../../src/features/coords/coordsOverrideRouting.js';

const enabledSettings = {
    enabled: true,
    messageText: 'ТОЧНЫЙ ОТВЕТ',
};

test('owner control commands are parsed separately from public response commands', () => {
    assert.equal(parseCoordsOverrideCommand('корды сообщение').action, 'set-message');
    assert.equal(parseCoordsOverrideCommand('/корды отключить!').action, 'disable');
    assert.equal(parseCoordsOverrideCommand('корды удалить').action, 'delete-message');
    assert.equal(parseCoordsOverrideCommand('корды удалить сообщение').action, 'delete-message');
    assert.equal(parseCoordsOverrideCommand('удалить сообщение').action, 'delete-message');

    assert.equal(parseCoordsOverrideCommand('корды рассылка').action, 'broadcast-start');
    assert.equal(parseCoordsOverrideCommand('корды ответить всем').action, 'broadcast-start');
    assert.equal(parseCoordsOverrideCommand('корды рассылка отправить').action, 'broadcast-send');
    assert.equal(parseCoordsOverrideCommand('корды рассылка отменить').action, 'broadcast-cancel');
    assert.equal(parseCoordsOverrideCommand('корды список').action, 'recipient-list');
    assert.equal(parseCoordsOverrideCommand('сколько запросило корды').action, 'recipient-stats');
    assert.equal(parseCoordsOverrideCommand('корды юзернеймы').action, 'recipient-usernames');
    assert.equal(parseCoordsOverrideCommand('корды получатели очистить').action, 'recipient-clear');
    assert.equal(parseCoordsOverrideCommand('разослать всем пересоздание').action, 'peresozdanie-broadcast-start');
    assert.equal(parseCoordsOverrideCommand('пересоздание отправить').action, 'peresozdanie-broadcast-send');
    assert.equal(parseCoordsOverrideCommand('пересоздание текст').action, 'peresozdanie-broadcast-edit');
    assert.equal(parseCoordsOverrideCommand('пересоздание шаблон').action, 'peresozdanie-template');
    assert.equal(parseCoordsOverrideCommand('пересоздание отзывы').action, 'peresozdanie-reviews');
    assert.equal(parseCoordsOverrideCommand('пересоздание отзывы статус').action, 'peresozdanie-review-stats');
    assert.equal(parseCoordsOverrideCommand('пересоздание спасибо').action, 'peresozdanie-thank');
    assert.equal(parseCoordsOverrideCommand('QR-код убрать').action, 'peresozdanie-qr-disable');
    assert.equal(parseCoordsOverrideCommand('QR-код вернуть').action, 'peresozdanie-qr-enable');
    assert.equal(parseCoordsOverrideCommand('пересоздание спасибо').ownerOnly, false);

    for (const input of [
        'координаты',
        'корды',
        'карды',
        'корды пересоздание',
        'карды пересоздание',
        'корды случайное пересоздание',
        'карды случайное пересоздание',
    ]) {
        const parsed = parseCoordsOverrideCommand(input);
        assert.equal(parsed.action, 'respond', input);
        assert.equal(parsed.ownerOnly, false, input);
    }

    assert.equal(parseCoordsOverrideCommand('покажи корды').matched, false);
    assert.equal(parseCoordsOverrideCommand('корды завтра').matched, false);
});

test('Moscow window is exactly 22 Aug 2026 from 11:00 until 24:00', () => {
    assert.equal(isCoordsOverrideWindow(new Date('2026-08-22T07:59:59.999Z')), false);
    assert.equal(isCoordsOverrideWindow(new Date('2026-08-22T08:00:00.000Z')), true);
    assert.equal(isCoordsOverrideWindow(new Date('2026-08-22T20:59:59.999Z')), true);
    assert.equal(isCoordsOverrideWindow(new Date('2026-08-22T21:00:00.000Z')), false);
});

test('public response requires active window while owner can test saved response at any time', () => {
    assert.equal(shouldSendCoordsOverride({
        requestText: 'корды пересоздание',
        settings: enabledSettings,
        now: new Date('2026-08-22T09:00:00.000Z'),
    }), true);

    assert.equal(shouldSendCoordsOverride({
        requestText: 'корды случайное пересоздание',
        settings: { ...enabledSettings, enabled: false },
        now: new Date('2026-08-22T12:00:00.000Z'),
    }), false);

    assert.equal(shouldSendCoordsOverride({
        requestText: 'корды',
        settings: { enabled: true, messageText: '' },
        now: new Date('2026-08-22T12:00:00.000Z'),
    }), false);

    assert.equal(shouldSendCoordsOverride({
        requestText: 'корды',
        settings: enabledSettings,
        now: new Date('2026-08-21T12:00:00.000Z'),
    }), false);

    assert.equal(shouldSendCoordsOverride({
        requestText: 'корды',
        settings: enabledSettings,
        now: new Date('2026-08-20T12:00:00.000Z'),
        owner: true,
    }), true);

    assert.equal(shouldSendCoordsOverride({
        requestText: 'корды пересоздание',
        settings: { ...enabledSettings, enabled: false },
        now: new Date('2026-08-20T12:00:00.000Z'),
        owner: true,
    }), false);
});

test('incoming fast-path is placed before DM notice and GPT request routing', () => {
    const source = readFileSync(
        new URL('../../src/app/botApplication.js', import.meta.url),
        'utf8',
    );
    const firstFastPath = source.indexOf('maybeHandleCoordsOverrideIncoming(context, text)');
    const dmNotice = source.indexOf('consumeDmAiNotice({');
    const requestRoute = source.indexOf('await handleRequest(context, dmRequestText)');

    assert.ok(firstFastPath >= 0);
    assert.ok(dmNotice > firstFastPath);
    assert.ok(requestRoute > firstFastPath);
    assert.match(source, /if \(!owner && !activePublicWindow\)/u);
    assert.match(source, /owner,/u);
    assert.match(source, /await context\.send\(settings\.messageText\);/u);
    assert.match(source, /await sendQrCodeResponse\(context, \{/u);
});

test('V99 source seeds the requested coordinates once without hard-resetting them on every restart', () => {
    const databaseSource = readFileSync(
        new URL('../../src/infrastructure/database/index.js', import.meta.url),
        'utf8',
    );

    assert.match(databaseSource, /events-v99-party-and-coords-2026-08-22/u);
    assert.match(databaseSource, /51\.691730, 39\.251385/u);
    assert.match(databaseSource, /bot_code_migrations/u);
});


test('Telegram explicit non-image routing recognizes V99 coords and nearest-party commands', () => {
    const telegramSource = readFileSync(
        new URL('../../src/platforms/telegram/telegramBot.js', import.meta.url),
        'utf8',
    );

    assert.match(telegramSource, /координаты\|корды/u);
    assert.match(telegramSource, /ближайш/u);
});


test('public coords requests have deterministic before/active/after window states', () => {
    assert.equal(getCoordsOverrideWindowState(new Date('2026-08-20T12:00:00.000Z')), 'before');
    assert.equal(getCoordsOverrideWindowState(new Date('2026-08-22T07:59:59.999Z')), 'before');
    assert.equal(getCoordsOverrideWindowState(new Date('2026-08-22T08:00:00.000Z')), 'active');
    assert.equal(getCoordsOverrideWindowState(new Date('2026-08-22T20:59:59.999Z')), 'active');
    assert.equal(getCoordsOverrideWindowState(new Date('2026-08-22T21:00:00.000Z')), 'after');
});

test('V100 organizer party fast-path is before VK DM notice and sends one canonical answer', () => {
    const source = readFileSync(
        new URL('../../src/app/botApplication.js', import.meta.url),
        'utf8',
    );
    const organizerFastPath = source.indexOf('maybeHandleOrganizerPartyIncoming(context, text)');
    const dmNotice = source.indexOf('consumeDmAiNotice({');

    assert.ok(organizerFastPath >= 0);
    assert.ok(dmNotice > organizerFastPath);
    assert.match(source, /const \[partyAnswer\] = getDmPartyFaqAnswers/u);
    assert.doesNotMatch(source, /partyAnswers\.join\('\n\n'\)/u);
    assert.match(source, /COORDS_PUBLIC_PREWINDOW_NOTICE/u);
    assert.match(source, /с 11:00 до 24:00/u);
});


test('V102 seeds one complete coords event message with Sber donation details, rules and start time', () => {
    const databaseSource = readFileSync(
        new URL('../../src/infrastructure/database/index.js', import.meta.url),
        'utf8',
    );

    assert.match(databaseSource, /events-v102-coords-sber-donation/u);
    assert.match(databaseSource, /51\.691730, 39\.251385/u);
    assert.match(databaseSource, /Всё исключительно добровольно/u);
    assert.match(databaseSource, /\+79968257889 \(Сбер\)/u);
    assert.match(databaseSource, /ПРАВИЛА ПОВЕДЕНИЯ И НАХОЖДЕНИЯ НА МЕРОПРИЯТИИ/u);
    assert.match(databaseSource, /Начало в 17:00/u);
    assert.match(databaseSource, /https:\/\/vk\.ru\/peresosdanie/u);
});
