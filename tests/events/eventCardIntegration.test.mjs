import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_OWNER_USER_ID = '701';
process.env.VK_TOKEN = 'test-only-never-sent';
process.env.VK_GROUP_ID = '701';
const { buildSinglePublicEventMessage, handleTelegramEventCardCallbackSafely } = await import('../../src/app/botApplication.js');
const { configureEventAnnouncementCopies, prepareEventAnnouncementCopies } = await import('../../src/features/events/eventAnnouncementCopies.js');
const { buildEventCardLinkMarkup, getEventCardLinkMarkupExpansion } = await import('../../src/features/events/eventCardLinks.js');
const db = await import('../../src/infrastructure/database/index.js');

test('full card preserves a fitting source and budgets all fields, VK instructions and link markup independently', async () => {
    const copies = new Map(); let request;
    configureEventAnnouncementCopies({
        render: (event, platform, text) => buildSinglePublicEventMessage(event, platform, text, true),
        markupExpansion: getEventCardLinkMarkupExpansion,
        load: key => copies.get(key), save: (key, value) => copies.set(key, value),
        edit: async input => { request = input; return { vk: 'Связное сокращение. '.repeat(5), telegram: 'Связное сокращение. '.repeat(5), shortSummary: 'Один абзац.\n\nВторой абзац.', ultraShortSummary: 'Раз. Два. Три.' }; },
    });
    const original = 'Точный текст, & детали <события> 🎸.\n\n'.repeat(87).trim();
    const [event] = await prepareEventAnnouncementCopies([{ title: 'Концерт', eventDate: '2099-10-31', eventTime: '18:00', venue: 'Diesel Hall, ул. Генерала Лизюкова, 4', participants: 'Группа', price: '1000 рублей', sourceUrl: 'https://vk.ru/wall-1_2' }], { sourceText: original });
    for (const platform of ['vk', 'telegram']) {
        const plain = buildSinglePublicEventMessage(event, platform);
        const linked = buildEventCardLinkMarkup(plain, { event, platform });
        assert.ok(linked.text.length <= 3996, `${platform}: ${linked.text.length}`);
        assert.ok(request.budgets[platform] > 0);
        if (original.length <= request.budgets[platform]) assert.ok(plain.includes(original));
        if (platform === 'vk') assert.ok(plain.includes('Источник:'));
        if (platform === 'vk') {
            assert.match(plain, /Попросить напомнить/u);
            assert.doesNotMatch(linked.text, /yandex/u);
            assert.match(linked.text, /\[https:\/\/vk\.(?:com|ru)\/rb_diesel\|Diesel Hall\]/u);
        } else {
            assert.doesNotMatch(plain, /Попросить напомнить|БОТ В ТГ/u);
            assert.match(linked.html, />Diesel Hall<\/a>, <a [^>]+>ул\. Генерала Лизюкова, 4<\/a>/u);
        }
    }
    assert.equal(event.description, original);
});

test('delete callbacks acknowledge, persist across reload, cancel safely, and reject stale, repeat and unauthorized presses', async () => {
    const first = db.saveManualEvent({ title: 'Выбранный концерт', eventDate: '2099-11-01', venue: 'Diesel Hall', sourceText: 'Оригинал.', ownerManual: true });
    const neighbour = db.saveManualEvent({ title: 'Соседний концерт', eventDate: '2099-11-01', venue: 'Diesel Hall', ownerManual: true });
    const messages = []; let answers = 0;
    const context = { platform: 'telegram', peerId: -3000000701, senderId: 3000000701, externalSenderId: '701', isDM: true, isChat: false,
        send: async value => { messages.push(value); }, answerCallbackQuery: async () => { answers++; } };
    const press = (data, extra = {}) => handleTelegramEventCardCallbackSafely({ ...context, ...extra, callbackQuery: { data } });
    const action = `event_delete:manual:${first}`;
    await press(action, { externalSenderId: '702' });
    assert.equal(messages.length, 0);
    await press(action);
    const buttons = messages.at(-1).replyMarkup.inline_keyboard[0];
    const oldConfirm = buttons[0].callback_data;
    await press(buttons[1].callback_data);
    assert.match(messages.at(-1), /отменено/u);
    await press(action);
    const newConfirm = messages.at(-1).replyMarkup.inline_keyboard[0][0].callback_data;
    await press(oldConfirm);
    assert.match(messages.at(-1), /устарело/u);
    assert.ok(db.getStoredEventByIdentity({ sourceType: 'manual', id: first }));
    // A new module instance has an empty in-memory confirmation map.
    const reloadUrl = new URL('../../src/app/botApplication.js', import.meta.url);
    reloadUrl.search = '?delete-reload-test';
    const reloaded = await import(reloadUrl.href);
    await reloaded.handleTelegramEventCardCallbackSafely({ ...context, callbackQuery: { data: newConfirm } });
    assert.equal(db.getStoredEventByIdentity({ sourceType: 'manual', id: first }), null);
    assert.ok(db.getStoredEventByIdentity({ sourceType: 'manual', id: neighbour }));
    await press(newConfirm);
    assert.match(messages.at(-1), /устарело/u);
    assert.ok(answers >= 7);
});

test('manual storage retains multi-event segments and explicit owner reparse replaces stale source text', () => {
    const id = db.saveManualEvent({ title: 'Из дайджеста', eventDate: '2099-11-02', description: 'Свой фрагмент.', sourceText: 'Общий пост о двух событиях.',
        isMultiAnnouncement: true, sourceSegment: 'Свой фрагмент.', structureDecision: 'multiple_events', ownerManual: true });
    const stored = db.getStoredEventByIdentity({sourceType:'manual',id});
    assert.equal(stored.isMultiAnnouncement, true);
    assert.equal(stored.sourceSegment, 'Свой фрагмент.');
    const changed = db.updateStoredEventRecordFromReparse({sourceType:'manual',id,forceReplace:true,event:{...stored,sourceText:'Свежий оригинальный пост.'}});
    assert.equal(changed, 1);
    assert.equal(db.getStoredEventByIdentity({sourceType:'manual',id}).sourceText, 'Свежий оригинальный пост.');
});
