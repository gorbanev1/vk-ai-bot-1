import assert from 'node:assert/strict';
import test from 'node:test';

import {
    parseQticketsBarePriceLimit,
    parseQticketsCommand,
    parseQticketsPriceLimit,
    qticketsEventMatchesPriceLimit,
    qticketsEventPriceFloorRubles,
    resolveQticketsWindowSpec,
} from '../../src/features/events/qticketsRouting.js';
import {
    TELEGRAM_MENU_BUTTONS,
    buildTelegramQticketsMenu,
    resolveTelegramMenuInput,
} from '../../src/platforms/telegram/telegramBot.js';

test('V188.87 QTickets text command accepts custom day count and price with or without rubles', () => {
    for (const input of [
        'qtickets тусы на ближайшие 5 дней по цене до 600 рублей',
        'qtickets тусы на ближайшие 5 дней по цене до 600 руб',
        'qtickets тусы на ближайшие 5 дней до 600',
        'кутикетс тусы на ближайшие 5 дней стоимость до 600',
    ]) {
        const parsed = parseQticketsCommand(input);
        assert.equal(parsed.matched, true, input);
        assert.equal(parsed.action, 'list', input);
        assert.equal(parsed.dayCount, 5, input);
        assert.equal(parsed.maxPrice, 600, input);
        assert.equal(parsed.weekendsOnly, false, input);
    }
    assert.equal(parseQticketsPriceLimit('на ближайшие 5 дней'), null);
});

test('V188.87 QTickets default window is seven days and weekend shortcut spans fourteen days', () => {
    assert.deepEqual(resolveQticketsWindowSpec(parseQticketsCommand('qtickets')), {
        dayCount: 7,
        weekendsOnly: false,
        usePublicRange: false,
    });
    assert.deepEqual(resolveQticketsWindowSpec(parseQticketsCommand('qtickets выходные')), {
        dayCount: 14,
        weekendsOnly: true,
        usePublicRange: false,
    });
});

test('V188.87 QTickets weekend mode is a dedicated weekend-only 14-day window', () => {
    const parsed = parseQticketsCommand('qtickets события выходные');
    assert.equal(parsed.weekendsOnly, true);
    assert.equal(parsed.dayCount, null);
});

test('V188.87 price prompt takes first number regardless of ruble wording', () => {
    assert.equal(parseQticketsBarePriceLimit('600'), 600);
    assert.equal(parseQticketsBarePriceLimit('до 600'), 600);
    assert.equal(parseQticketsBarePriceLimit('600 рублей'), 600);
    assert.equal(parseQticketsBarePriceLimit('максимум 750 руб.'), 750);
    assert.equal(parseQticketsBarePriceLimit('без цены'), null);
});

test('V188.87 QTickets event price filtering uses available floor and excludes unknown price', () => {
    assert.equal(qticketsEventPriceFloorRubles({ price: 'Бесплатно' }), 0);
    assert.equal(qticketsEventPriceFloorRubles({ price: 'от 500 руб.' }), 500);
    assert.equal(qticketsEventPriceFloorRubles({ price: '500–900 ₽' }), 500);
    assert.equal(qticketsEventMatchesPriceLimit({ price: 'от 500 руб.' }, 600), true);
    assert.equal(qticketsEventMatchesPriceLimit({ price: '700 ₽' }, 600), false);
    assert.equal(qticketsEventMatchesPriceLimit({ price: '' }, 600), false);
});

test('V188.87 Telegram QTickets button opens a submenu with periods and price filter', () => {
    const opened = resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.qtickets, {}, { isOwner: false });
    assert.equal(opened.type, 'response');
    assert.equal(opened.state.menuPath, 'qtickets');
    const buttons = opened.replyMarkup.keyboard.flat().map((button) => button.text);
    assert.ok(buttons.includes(TELEGRAM_MENU_BUTTONS.qticketsWeek));
    assert.ok(buttons.includes(TELEGRAM_MENU_BUTTONS.qticketsWeekends));
    assert.ok(buttons.includes(TELEGRAM_MENU_BUTTONS.qticketsPriceFilter));
    assert.match(opened.text, /ближайшие 7 дней/u);
    assert.match(opened.text, /600 рублей/u);
});

test('V188.87 Telegram QTickets price filter persists into period buttons', () => {
    const prompt = resolveTelegramMenuInput(
        TELEGRAM_MENU_BUTTONS.qticketsPriceFilter,
        { menuPath: 'qtickets' },
        { isOwner: false },
    );
    assert.equal(prompt.state.pendingAction, 'qtickets_price_filter');

    const set = resolveTelegramMenuInput(
        'до 600 рублей',
        prompt.state,
        { isOwner: false },
    );
    assert.equal(set.type, 'response');
    assert.equal(set.state.qticketsMaxPrice, '600');
    assert.match(set.text, /до 600 ₽/u);

    const week = resolveTelegramMenuInput(
        TELEGRAM_MENU_BUTTONS.qticketsWeek,
        set.state,
        { isOwner: false },
    );
    assert.equal(week.type, 'command');
    assert.equal(week.text, 'qtickets события на ближайшие 7 дней до 600');

    const weekends = resolveTelegramMenuInput(
        TELEGRAM_MENU_BUTTONS.qticketsWeekends,
        set.state,
        { isOwner: false },
    );
    assert.equal(weekends.type, 'command');
    assert.equal(weekends.text, 'qtickets события выходные на ближайшие 14 дней до 600');
});

test('V188.87 free-text party query inside QTickets section stays in QTickets namespace', () => {
    const result = resolveTelegramMenuInput(
        'тусы на ближайшие 3 дня по цене до 450 рублей',
        { menuPath: 'qtickets', qticketsMaxPrice: '600' },
        { isOwner: false },
    );
    assert.equal(result.type, 'command');
    assert.equal(result.text, 'qtickets тусы на ближайшие 3 дня по цене до 450 рублей');

    const parsed = parseQticketsCommand(result.text);
    assert.equal(parsed.dayCount, 3);
    assert.equal(parsed.maxPrice, 450);
});

test('V188.87 QTickets menu shows reset only while a price limit is active', () => {
    const plain = buildTelegramQticketsMenu({ isOwner: false });
    const plainButtons = plain.keyboard.flat().map((button) => button.text);
    assert.ok(!plainButtons.includes(TELEGRAM_MENU_BUTTONS.qticketsPriceReset));

    const filtered = buildTelegramQticketsMenu({ isOwner: false, maxPrice: 600 });
    const filteredButtons = filtered.keyboard.flat().map((button) => button.text);
    assert.ok(filteredButtons.includes(TELEGRAM_MENU_BUTTONS.qticketsPriceReset));
});
