import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildReminderHelp, createReminderManager, parseReminderCommand } from '../../src/features/telegram/reminderManager.js';
import { resolveTelegramMenuInput } from '../../src/platforms/telegram/telegramBot.js';

const now = new Date('2026-10-05T07:00:00.000Z');

test('parses natural reminder schedules and Milana aliases', () => {
    const random = parseReminderCommand('напомни мне завтра с 10 часов до 15 часов 3 раза рандомно проверить почту', { now, timeZone: 'Europe/Moscow' });
    assert.equal(random.type, 'create');
    assert.equal(random.count, 3);
    assert.equal(random.random, true);
    assert.equal(random.content, 'проверить почту');
    assert.equal(random.times.length, 3);

    const milana = parseReminderCommand('напомни Милане 3 раза раз в час подстричь когти котам', { now, timeZone: 'Europe/Moscow' });
    assert.equal(milana.target, 'milana');
    assert.equal(milana.count, 3);
    assert.equal(milana.content, 'подстричь когти котам');

    const relative = parseReminderCommand('напомни мне через 2 часа позвонить', { now, timeZone: 'Europe/Moscow' });
    assert.equal(relative.content, 'позвонить');
    assert.equal(relative.times[0], now.getTime() + 2 * 60 * 60 * 1000);
});

test('parses monthly day anchors and two sends per day regardless of block order', () => {
    const commands = [
        'напоминай с 14 числа каждого месяца 2 раза в день с 10:00 до 16:00 Отправить ТНС',
        'напоминай с 14 числа каждого месяца с 10:00 до 16:00 2 раза в день Отправить ТНС',
        'напоминай 2 раза в день с 10:00 до 16:00 с 14 числа каждого месяца Отправить ТНС',
    ];
    for (const command of commands) {
        const parsed = parseReminderCommand(command, { now, timeZone: 'Europe/Moscow' });
        assert.equal(parsed.type, 'create', command);
        assert.equal(parsed.content, 'Отправить ТНС');
        assert.equal(parsed.cadence, 'monthly');
        assert.equal(parsed.schedule.monthDay, 14);
        assert.equal(parsed.schedule.dailyCountPerDay, 2);
        assert.equal(parsed.times.length, 62);
        assert.equal(new Date(parsed.times[0]).toISOString(), '2026-10-14T07:00:00.000Z');
        assert.equal(new Date(parsed.times[1]).toISOString(), '2026-10-14T13:00:00.000Z');
    }
});

test('parses monthly cadence with an arbitrary start day and daily count', () => {
    const parsed = parseReminderCommand('напоминай ежемесячно с 12 числа 3 раза в день с 10:00 до 20:00 отправить ТНС', { now, timeZone: 'Europe/Moscow' });
    assert.equal(parsed.type, 'create');
    assert.equal(parsed.cadence, 'monthly');
    assert.equal(parsed.schedule.monthDay, 12);
    assert.equal(parsed.schedule.dailyCountPerDay, 3);
    assert.equal(parsed.times.length, 93);
});

test('monthly day reminder rolls forward to the same day next month', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'vk-reminder-monthly-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    let current = now.getTime();
    const sent = [];
    const manager = createReminderManager({
        api: { sendMessage: async payload => { sent.push(payload); return { message_id: sent.length }; } },
        storagePath: join(directory, 'state.json'), ownerExternalUserId: '1', now: () => current,
    });
    const context = { platform: 'telegram', isDM: true, externalPeerId: '1', externalSenderId: '1', peerId: '1',
        text: 'напоминай с 14 числа каждого месяца 2 раза в день с 10:00 до 16:00 Отправить ТНС',
        send: async () => {}, answerCallbackQuery: async () => {} };
    assert.equal(await manager.handleIncoming(context), true);
    let reminder = manager.getState().reminders[0];
    for (let index = 0; index < 62; index += 1) {
        current = reminder.nextAt; await manager.tick();
        reminder = manager.getState().reminders[0];
    }
    assert.equal(sent.length, 62);
    assert.equal(reminder.active, true);
    assert.equal(reminder.cycleDay.day, 14);
    assert.equal(reminder.cycleDay.month, 11);
    assert.equal(reminder.nextAt, Date.parse('2026-11-14T07:00:00.000Z'));
});

test('stops only by replying to the reminder message', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'vk-reminders-'));
    const path = join(directory, 'reminders.json');
    const sent = [];
    const api = { sendMessage: async payload => { sent.push(payload); return { message_id: 77 }; } };
    let current = now.getTime();
    const manager = createReminderManager({ api, storagePath: path, ownerExternalUserId: '1', now: () => current });
    const context = {
        platform: 'telegram', isDM: true, externalPeerId: '1', externalSenderId: '1', peerId: '1',
        originalText: 'напомни мне через 1 минуту 3 раза проверить', text: 'напомни мне через 1 минуту 3 раза проверить',
        replyMessage: null, send: async message => message,
    };
    assert.equal(await manager.handleIncoming(context), true);
    current += 61_000;
    await manager.tick();
    assert.equal(sent.length, 1);
    const ack = { ...context, originalText: 'сделала', text: 'сделала', replyMessage: { conversationMessageId: 77, isBot: true } };
    assert.equal(await manager.handleIncoming(ack), true);
    assert.equal(manager.getState().reminders.some(item => item.kind === 'user' && item.active), false);
    rmSync(directory, { recursive: true, force: true });
});

test('help lists personal and Milana command forms', () => {
    const help = buildReminderHelp();
    assert.match(help, /напомни мне завтра/iu);
    assert.match(help, /напиши Милане/iu);
    assert.match(help, /сделала/iu);
});

test('event reminder flow stores one personal reminder only after confirmation and rejects stale callbacks', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'vk-event-reminder-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    let current = Date.parse('2026-10-01T08:00:00.000Z');
    const sent = [];
    const manager = createReminderManager({
        api: { sendMessage: async payload => { sent.push(payload); return { message_id: sent.length }; } },
        storagePath: join(directory, 'state.json'), now: () => current, random: () => 0.25,
        resolveEvent: async () => ({ eventDate: '2026-10-24', eventTime: '19:00' }),
    });
    const replies = [];
    const context = { platform: 'telegram', isDM: true, externalPeerId: '77', externalSenderId: '77',
        send: async value => replies.push(value), answerCallbackQuery: async () => {} };
    assert.equal(await manager.beginEventReminder(context, { sourceType: 'vk', id: 12, title: 'Концерт', eventDate: '2026-10-24', eventTime: '19:00', cardText: '🎸 Концерт' }), true);
    const session = manager.getState().eventSessions[0];
    assert.equal(session.state, 'SELECTING');
    await manager.handleCallback({ ...context, callbackQuery: { data: 'evrem:choose:' + session.id + ':0' } });
    const pending = manager.getState().eventSessions[0];
    assert.equal(pending.state, 'AWAITING_CONFIRMATION');
    assert.equal(manager.getState().reminders.some(item => item.eventReminder), false);
    const confirm = 'evrem:confirm:' + pending.id + ':' + pending.revision;
    await manager.handleCallback({ ...context, callbackQuery: { data: confirm } });
    assert.equal(manager.getState().reminders.filter(item => item.eventReminder && item.active).length, 1);
    await manager.handleCallback({ ...context, callbackQuery: { data: confirm } });
    assert.equal(manager.getState().reminders.filter(item => item.eventReminder && item.active).length, 1);
    assert.ok(replies.some(reply => /Напоминание установлено/iu.test(String(reply))));
});

test('event reminder sessions are bound to user/chat and expire without saving', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'vk-event-reminder-expiry-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    let current = Date.parse('2026-10-01T08:00:00.000Z');
    const sent = [];
    const manager = createReminderManager({ api: { sendMessage: async payload => { sent.push(payload); return { message_id: sent.length }; } },
        storagePath: join(directory, 'state.json'), now: () => current });
    const context = { platform: 'telegram', isDM: true, externalPeerId: '7', externalSenderId: '7', send: async () => {}, answerCallbackQuery: async () => {} };
    await manager.beginEventReminder(context, { sourceType: 'vk', id: 1, title: 'Событие', eventDate: '2026-10-30', eventTime: '20:00' });
    const session = manager.getState().eventSessions[0];
    await manager.handleCallback({ ...context, externalSenderId: '8', callbackQuery: { data: 'evrem:back:' + session.id } });
    assert.equal(manager.getState().eventSessions.length, 1);
    current = session.expiresAt;
    await manager.tick();
    assert.ok(sent.some(item => /время настройки напоминания истекло/iu.test(item.text)));
    await manager.handleCallback({ ...context, callbackQuery: { data: 'evrem:choose:' + session.id + ':0' } });
    assert.equal(manager.getState().reminders.some(item => item.eventReminder), false);
});

test('event reminder delivery uses the existing tick scheduler and includes its source link', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'vk-event-reminder-delivery-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    let current = Date.parse('2026-10-01T08:00:00.000Z');
    const sent = [];
    const event = { eventDate: '2026-10-30', eventTime: '20:00', title: 'Концерт', venue: 'Клуб', sourceUrl: 'https://vk.ru/wall-1_2' };
    const manager = createReminderManager({ api: { sendMessage: async payload => { sent.push(payload); return { message_id: sent.length }; } },
        storagePath: join(directory, 'state.json'), now: () => current, resolveEvent: async () => event });
    const replies = [];
    const context = { platform: 'telegram', isDM: true, externalPeerId: '7', externalSenderId: '7', send: async value => replies.push(value), answerCallbackQuery: async () => {} };
    await manager.beginEventReminder(context, { ...event, sourceType: 'vk', id: 2 });
    const session = manager.getState().eventSessions[0];
    await manager.handleCallback({ ...context, callbackQuery: { data: 'evrem:choose:' + session.id + ':0' } });
    const waiting = manager.getState().eventSessions[0];
    await manager.handleCallback({ ...context, callbackQuery: { data: 'evrem:confirm:' + waiting.id + ':' + waiting.revision } });
    current = manager.getState().reminders.find(item => item.eventReminder).nextAt;
    await manager.tick();
    const delivery = sent.find(item => String(item.text || '').startsWith('🔔 Напоминание:'));
    assert.match(delivery.text, /Концерт/iu);
    assert.match(delivery.text, /https:\/\/vk\.ru\/wall-1_2/u);
    assert.equal(manager.getState().reminders.find(item => item.eventReminder).active, false);
});

test('group event reminder asks for a schedule, then sends a short notice before a separate card delivery', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'vk-event-reminder-group-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    let current = Date.parse('2026-10-01T08:00:00.000Z');
    const delivered = [];
    const event = { sourceType: 'vk', id: 77, eventDate: '2026-10-24', eventTime: '19:00', title: 'Концерт', venue: 'Diesel Hall' };
    const manager = createReminderManager({ ownerVkUserId: '17',
        api: { sendMessage: async () => ({ message_id: 1 }) },
        storagePath: join(directory, 'state.json'), now: () => current, resolveEvent: async () => event,
        sendEventReminder: async payload => { delivered.push(payload); return { message_id: delivered.length }; },
    });
    const replies = [];
    const context = { platform: 'vk', isDM: false, externalPeerId: '2000000017', externalSenderId: '17', peerId: 701, send: async value => replies.push(value) };
    await manager.handleGroupEventReminder(context, event, { platform: 'vk', chatId: '2000000017', peerId: 701, endpointKey: 'vk:primary' });
    assert.equal(manager.getState().reminders.some(item => item.groupEventReminder), false);
    assert.match(replies[0].message, /Я напомню в этой беседе/iu);
    assert.match(replies[0].message, /Концерт/u);
    assert.match(replies[0].message, /24 октября 2026/u);
    assert.match(replies[0].message, /Diesel Hall/u);
    assert.match(replies[0].message, /Начало: 19:00/u);
    assert.deepEqual(JSON.parse(replies[0].keyboard).buttons.map(row => row[0].action.label), [
        'В 09:00', 'В 12:00', 'В 09:00 и 12:00', 'В 12:00 и 14:00', 'В 10:00, 13:00 и 15:00',
    ]);
    const session = manager.getState().eventSessions.find(item => item.kind === 'group-event-reminder');
    await manager.handleCallback({ ...context, callbackQuery: { data: 'evgrouprem:choose:' + session.id + ':0' } });
    const reminder = manager.getState().reminders.find(item => item.groupEventReminder);
    assert.ok(reminder);
    assert.equal(reminder.chatId, '2000000017');
    assert.equal(reminder.deliveryTarget, 'chat');
    assert.match(replies.at(-1), /Напоминания придут в этот чат/iu);
    assert.match(replies.at(-1), /24 октября 2026/u);
    assert.match(replies.at(-1), /Diesel Hall/u);
    assert.match(replies.at(-1), /Начало: 19:00/u);
    assert.ok(reminder);
    current = reminder.nextAt;
    await manager.tick();
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].text, '🔔 Напоминаю вам о сегодняшнем событии.');
    assert.equal(delivered[0].chatId, '2000000017');
    assert.equal(delivered[0].groupEventReminder, true);
    assert.equal(reminder.groupEventReminder, true);
});

test('group reminder choices must all precede the event start', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'vk-event-reminder-group-filter-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const event = { sourceType: 'vk', id: 79, eventDate: '2026-10-24', eventTime: '10:00', title: 'Утренний концерт' };
    const manager = createReminderManager({ ownerVkUserId: '18',
        api: { sendMessage: async () => ({ message_id: 1 }) },
        storagePath: join(directory, 'state.json'), now: () => Date.parse('2026-10-01T08:00:00.000Z'),
        resolveEvent: async () => event,
    });
    const replies = [];
    const context = { platform: 'vk', isDM: false, externalPeerId: '2000000018', externalSenderId: '18', send: async value => replies.push(value) };
    await manager.handleGroupEventReminder(context, event, { platform: 'vk', chatId: '2000000018', peerId: 702, endpointKey: 'vk:primary' });
    assert.deepEqual(JSON.parse(replies[0].keyboard).buttons.map(row => row[0].action.label), ['В 09:00']);
    const session = manager.getState().eventSessions.find(item => item.kind === 'group-event-reminder');
    await manager.handleCallback({ ...context, callbackQuery: { data: 'evgrouprem:choose:' + session.id + ':0' } });
    assert.ok(manager.getState().reminders.find(item => item.groupEventReminder)?.times.every(at => at < Date.parse('2026-10-24T07:00:00.000Z')));
});

test('VK group reminder keyboard routes the selected schedule back to the group reminder handler', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'vk-event-reminder-vk-group-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    let current = Date.parse('2026-10-01T08:00:00.000Z');
    const event = { sourceType: 'vk', id: 80, eventDate: '2026-10-24', eventTime: '19:00', title: 'VK-шоу', venue: 'Клуб «12»' };
    const manager = createReminderManager({ ownerVkUserId: '99', api: { sendMessage: async () => ({ message_id: 1 }) },
        storagePath: join(directory, 'state.json'), now: () => current, resolveEvent: async () => event });
    const replies = [];
    const context = { platform: 'vk', isDM: false, externalPeerId: '2000000027', externalSenderId: '99', peerId: 2_000_000_027,
        send: async value => replies.push(value), answerCallbackQuery: async () => {} };
    await manager.handleGroupEventReminder(context, event, { platform: 'vk', chatId: '2000000027', peerId: 2_000_000_027, endpointKey: 'vk:primary' });
    const keyboard = JSON.parse(replies[0].keyboard);
    assert.equal(keyboard.buttons.length, 5);
    const callbackData = JSON.parse(keyboard.buttons[0][0].action.payload).data;
    assert.match(callbackData, /^evgrouprem:choose:/u);
    await manager.handleCallback({ ...context, callbackQuery: { data: callbackData } });
    const reminder = manager.getState().reminders.find(item => item.groupEventReminder);
    assert.ok(reminder);
    assert.equal(reminder.platform, 'vk');
    assert.equal(reminder.chatId, '2000000027');
    assert.equal(reminder.deliveryTarget, 'chat');
    assert.match(replies.at(-1), /Напоминания придут в этот чат/iu);
});

test('personal reminders for two group members are coalesced at the same event time', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'vk-event-reminder-subscribers-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    let current = Date.parse('2026-10-01T08:00:00.000Z');
    const delivered = [];
    const event = { sourceType: 'vk', id: 78, eventDate: '2026-10-24', eventTime: '19:00', title: 'Шоу' };
    const manager = createReminderManager({
        api: { sendMessage: async () => ({ message_id: 1 }) },
        storagePath: join(directory, 'state.json'), now: () => current, resolveEvent: async () => event,
        sendEventReminder: async payload => { delivered.push(payload); return { message_id: delivered.length }; },
    });
    const groupId = '2000000019';
    const makeContext = (id, displayName) => ({
        platform: 'vk', isDM: false, externalPeerId: groupId, externalSenderId: id, externalSenderName: displayName,
        externalSenderUsername: 'user' + id, peerId: 709, send: async () => {},
    });
    const firstContext = makeContext('21', 'Аня');
    const secondContext = makeContext('22', 'Борис');
    await manager.beginEventReminder(firstContext, event, { platform: 'vk', chatId: groupId, peerId: 709, endpointKey: 'vk:primary', deliveryTarget: 'chat', displayName: 'Аня' });
    await manager.beginEventReminder(secondContext, event, { platform: 'vk', chatId: groupId, peerId: 709, endpointKey: 'vk:primary', deliveryTarget: 'chat', displayName: 'Борис' });
    for (const context of [firstContext, secondContext]) {
        const session = manager.getState().eventSessions.find(item => item.userId === context.externalSenderId);
        await manager.handleCallback({ ...context, callbackQuery: { data: 'evrem:choose:' + session.id + ':0' } });
        const selected = manager.getState().eventSessions.find(item => item.userId === context.externalSenderId);
        await manager.handleCallback({ ...context, callbackQuery: { data: 'evrem:confirm:' + selected.id + ':' + selected.revision } });
    }
    const at = manager.getState().reminders.find(item => item.eventReminder).nextAt;
    current = at;
    await manager.tick();
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].chatId, groupId);
    assert.equal(delivered[0].text, '🔔 Ты просил напомнить о событии «Шоу».');
    assert.deepEqual(delivered[0].subscribers.map(item => item.id).sort(), ['21', '22']);
});

test('event command templates use the current card date and keep a two-time reminder together', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'vk-event-reminder-template-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    let current = Date.parse('2026-10-01T08:00:00.000Z');
    const manager = createReminderManager({ api: { sendMessage: async () => ({ message_id: 1 }) },
        storagePath: join(directory, 'state.json'), now: () => current,
        resolveEvent: async () => ({ eventDate: '2026-10-24', eventTime: '20:00' }) });
    const replies = [];
    const context = { platform: 'telegram', isDM: true, externalPeerId: '9', externalSenderId: '9', text: '',
        send: async value => replies.push(value), answerCallbackQuery: async () => {} };
    await manager.beginEventReminder(context, { sourceType: 'vk', id: 3, title: 'Тест', eventDate: '2026-10-24', eventTime: '20:00' });
    await manager.handleIncoming({ ...context, text: 'напомни за день в 19:00 и в день события в 14:00' });
    let session = manager.getState().eventSessions[0];
    assert.equal(session.state, 'AWAITING_CONFIRMATION');
    assert.equal(session.pending.times.length, 2);
    assert.deepEqual(session.pending.times.map(value => new Date(value).toISOString()), ['2026-10-23T16:00:00.000Z', '2026-10-24T11:00:00.000Z']);
    await manager.handleCallback({ ...context, callbackQuery: { data: 'evrem:confirm:' + session.id + ':' + session.revision } });
    const reminder = manager.getState().reminders.find(item => item.eventReminder);
    assert.equal(reminder.times.length, 2);
    assert.equal(reminder.remaining, 2);
    assert.match(replies.find(reply => /Подтвердите установку/iu.test(reply.message)).message, /Новых уведомлений: 2/iu);
});

test('sends a reminder guide to owner and Milana, repeats it in 1-3 hours, and stops by button', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'vk-reminder-nudges-'));
    const path = join(directory, 'reminders.json');
    const sent = [];
    let current = now.getTime();
    const api = { sendMessage: async payload => { sent.push(payload); return { message_id: sent.length }; } };
    const manager = createReminderManager({ api, storagePath: path, ownerExternalUserId: '8019356616', defaultChatId: '2', defaultUserId: '2', defaultPeerId: '-3', now: () => current, random: () => 0.5 });
    manager.start();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(sent.filter(item => /как задавать напоминания/iu.test(item.text)).length, 2);
    assert.ok(sent.every(item => item.text.length <= 3500));
    assert.equal(sent.filter(item => item.replyMarkup?.inline_keyboard?.[0]?.[0]?.text === 'Понял(а)').length, 2);
    assert.equal(sent.length, 4);
    const ownerNudge = manager.getState().helpNudges.find(item => item.id === 'owner');
    assert.equal(ownerNudge.nextAt - current, 2 * 60 * 60_000);

    const callbackContext = {
        platform: 'telegram', isDM: true, externalPeerId: '8019356616', externalSenderId: '8019356616',
        callbackQuery: { data: 'remhelp:owner' }, answerCallbackQuery: async () => {}, send: async () => {},
    };
    assert.equal(await manager.handleCallback(callbackContext), true);
    assert.equal(manager.getState().helpNudges.find(item => item.id === 'owner').active, false);

    const commandContext = {
        platform: 'telegram', isDM: true, externalPeerId: '8019356616', externalSenderId: '8019356616', peerId: '1',
        originalText: 'напомни мне каждые 1 минуту 3 раза проверить', text: 'напомни мне каждые 1 минуту 3 раза проверить',
        replyMessage: null, send: async () => {},
    };
    await manager.handleIncoming(commandContext);
    current += 61_000;
    await manager.tick();
    const reminderPayload = sent.find(item => item.text.startsWith('🔔 Напоминание:'));
    assert.equal(reminderPayload.replyMarkup.inline_keyboard[0][0].text, 'Сделал(а)');
    const reminder = manager.getState().reminders.find(item => item.kind === 'user' && item.active);
    assert.equal(await manager.handleCallback({ ...callbackContext, callbackQuery: { data: 'remdone:' + reminder.id, message: { message_id: reminder.lastMessageId } } }), true);
    assert.equal(manager.getState().reminders.find(item => item.id === reminder.id).active, false);
    manager.stop();
    rmSync(directory, { recursive: true, force: true });
});

test('editing is recipient-bound, durable, explicit-confirmation-only and rejects stale buttons', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'vk-reminder-edit-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const storagePath = join(directory, 'reminders.json');
    let current = now.getTime();
    const sent = []; const replies = [];
    const api = { sendMessage: async payload => { sent.push(payload); return { message_id: sent.length }; } };
    const options = { api, storagePath, ownerExternalUserId: '1', now: () => current };
    let manager = createReminderManager(options);
    const context = { platform: 'telegram', isDM: true, externalPeerId: '1', externalSenderId: '1',
        send: async value => replies.push(value), answerCallbackQuery: async () => {} };
    const input = text => manager.handleIncoming({ ...context, text });
    const click = (data, extra = {}) => manager.handleCallback({ ...context, callbackQuery: { data, message: { message_id: 1 } }, ...extra });
    await input('напомни мне через 1 минуту 3 раза проверить почту');
    current += 61_000; await manager.tick();
    const before = manager.getState().reminders[0];
    assert.equal(sent[0].replyMarkup.inline_keyboard[1][0].text, 'Изменить напоминание');
    await click('remedit:' + before.id, { externalSenderId: '2' });
    assert.equal(manager.getState().edits.length, 0);
    await click('remedit:' + before.id);
    assert.match(replies.at(-1).message, /напомни мне завтра/);
    await input('непонятная строка');
    assert.equal(manager.getState().edits[0].proposal, null);
    assert.deepEqual(manager.getState().reminders[0], before);
    await input('напомни мне завтра с 10:00 до 15:00 3 раза рандомно забрать заказ');
    assert.match(replies.at(-1).message, /Изменяю так:/);
    const oldToken = manager.getState().edits[0].token;
    const proposedTimes = manager.getState().edits[0].proposal.times;
    assert.deepEqual(manager.getState().reminders[0], before);
    manager = createReminderManager(options);
    assert.deepEqual(manager.getState().edits[0].proposal.times, proposedTimes);
    await click('remrevise:' + oldToken);
    assert.equal(manager.getState().edits[0].proposal, null);
    await click('remconfirm:' + oldToken);
    assert.deepEqual(manager.getState().reminders[0], before);
    await input('напомни мне завтра в 12:30 забрать заказ');
    const token = manager.getState().edits[0].token;
    await click('remconfirm:' + token);
    const after = manager.getState().reminders[0];
    assert.equal(after.id, before.id);
    assert.equal(after.text, 'забрать заказ');
    assert.equal(after.nextAt, Date.parse('2026-10-06T09:30:00Z'));
    assert.equal(manager.getState().reminders.length, 1);
    assert.equal(manager.getState().edits.length, 0);
    await click('remdone:' + before.id);
    assert.equal(manager.getState().reminders[0].active, true, 'old message must not stop edited schedule');
    await click('remconfirm:' + token);
    assert.deepEqual(manager.getState().reminders[0], after);
});

test('acknowledged help does not return after restart, other recipient keeps random repeats', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'vk-reminder-help-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    let current = now.getTime(); const sent = [];
    const api = { sendMessage: async payload => { sent.push(payload); return { message_id: sent.length }; } };
    const options = { api, storagePath: join(directory, 'state.json'), ownerExternalUserId: '1', now: () => current, random: () => 0.75 };
    let manager = createReminderManager(options);
    manager.ensureHelpNudges(); await manager.tick();
    assert.equal(sent.length, 4);
    assert.ok(sent.every(item => item.text.length <= 3500));
    await manager.handleCallback({ platform: 'telegram', isDM: true, externalPeerId: '1', externalSenderId: '1', callbackQuery: { data: 'remhelp:owner' }, answerCallbackQuery: async () => {}, send: async () => {} });
    manager = createReminderManager(options); manager.ensureHelpNudges();
    current += 3 * 3_600_000; await manager.tick();
    assert.equal(sent.length, 6);
    assert.equal(sent[4].chatId, '8019356616');
    const remaining = manager.getState().helpNudges.find(item => item.id === 'milana');
    assert.ok(remaining.nextAt - current >= 3_600_000 && remaining.nextAt - current <= 10_800_000);
});

test('invalid dates and times cannot become edit proposals', () => {
    for (const command of ['напомни мне завтра в 25:00 проверить', 'напомни мне 31.02.2027 проверить', 'напомни мне через 0 минут проверить']) {
        assert.equal(parseReminderCommand(command, { now }).type, 'invalid', command);
    }
});

test('reminder command escapes pending Telegram image menu', () => {
    const result = resolveTelegramMenuInput('напомни мне завтра в 12:30 проверить почту', { pendingAction: 'image-generate', imageModel: 'gpt-image-2' });
    assert.notEqual(result.type, 'response');
    assert.ok(!result.text || !result.text.startsWith('gpt картинка'));
});

test('weekly completion advances once; a repeated button cannot postpone another week', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'vk-reminder-weekly-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    let current = now.getTime(); let messageId = 0;
    const manager = createReminderManager({ storagePath: join(directory, 'state.json'), now: () => current,
        api: { sendMessage: async () => ({ message_id: ++messageId }) } });
    manager.ensureMilanaReminder();
    current = manager.getState().reminders[0].nextAt;
    await manager.tick();
    const context = { platform: 'telegram', isDM: true, externalPeerId: '8019356616', externalSenderId: '8019356616',
        callbackQuery: { data: 'remdone:milana-weekly', message: { message_id: messageId } }, answerCallbackQuery: async () => {}, send: async () => {} };
    await manager.handleCallback(context);
    const next = manager.getState().reminders[0].nextAt;
    assert.equal(next, current + 7 * 86_400_000);
    await manager.handleCallback(context);
    assert.equal(manager.getState().reminders[0].nextAt, next);
});

test('AI reminder clarification is owner/Milana-only and requires explicit installation', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'vk-reminder-ai-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const sent = []; const replies = []; let aiCalls = 0;
    const nowMs = now.getTime();
    const api = { sendMessage: async payload => { sent.push(payload); return { message_id: sent.length }; } };
    const manager = createReminderManager({
        api,
        storagePath: join(directory, 'state.json'),
        ownerExternalUserId: 'owner',
        defaultChatId: 'milana-chat',
        defaultUserId: 'milana',
        now: () => nowMs,
        parseReminderWithAi: async ({ text }) => {
            aiCalls += 1;
            assert.match(text, /напомни/iu);
            return { understood: true, command: 'напомни мне завтра в 12:30 проверить почту' };
        },
    });
    const owner = { platform: 'telegram', isDM: true, externalPeerId: 'owner', externalSenderId: 'owner', peerId: 'owner',
        text: 'напомни странно проверить почту', originalText: 'напомни странно проверить почту',
        send: async value => replies.push(value), answerCallbackQuery: async () => {} };
    assert.equal(await manager.handleIncoming(owner), true);
    assert.equal(aiCalls, 1);
    assert.equal(manager.getState().reminders.length, 0);
    assert.match(replies[0], /Синтаксис не распознан автоматически/iu);
    const proposalMessage = replies.at(-1);
    const token = manager.getState().aiProposals[0].token;
    assert.equal(proposalMessage.replyMarkup.inline_keyboard[0][0].text, 'Установить');
    await manager.handleCallback({ ...owner, callbackQuery: { data: 'remaiproposal:confirm:' + token }, send: async value => replies.push(value) });
    assert.equal(manager.getState().reminders.length, 1);
    assert.equal(manager.getState().reminders[0].text, 'проверить почту');

    const outsider = { ...owner, externalPeerId: 'other', externalSenderId: 'other', text: 'напомни странно проверить', originalText: 'напомни странно проверить', send: async value => replies.push(value) };
    assert.equal(await manager.handleIncoming(outsider), true);
    assert.equal(aiCalls, 1);
});

test('owner and Milana can address each other with the same reminder syntax', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'vk-reminder-mutual-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const sent = []; const replies = []; const current = now.getTime();
    const manager = createReminderManager({ api: { sendMessage: async payload => { sent.push(payload); return { message_id: sent.length }; } },
        storagePath: join(directory, 'state.json'), ownerExternalUserId: 'owner', defaultChatId: 'milana-chat', defaultUserId: 'milana', defaultPeerId: '-3', now: () => current });
    const base = { platform: 'telegram', isDM: true, peerId: '', replyMessage: null, send: async value => replies.push(value), answerCallbackQuery: async () => {} };
    const owner = { ...base, externalPeerId: 'owner', externalSenderId: 'owner', text: 'напомни Милане завтра в 12:00 проверить почту', originalText: 'напомни Милане завтра в 12:00 проверить почту' };
    assert.equal(await manager.handleIncoming(owner), true);
    assert.equal(manager.getState().reminders.at(-1).chatId, 'milana-chat');
    assert.equal(manager.getState().reminders.at(-1).userId, 'milana');
    const milana = { ...base, externalPeerId: 'milana-chat', externalSenderId: 'milana', text: 'напомни Игорю завтра в 13:00 позвонить', originalText: 'напомни Игорю завтра в 13:00 позвонить' };
    assert.equal(await manager.handleIncoming(milana), true);
    assert.equal(manager.getState().reminders.at(-1).chatId, 'owner');
    assert.equal(manager.getState().reminders.at(-1).userId, 'owner');
    const outsider = { ...base, externalPeerId: 'other', externalSenderId: 'other', text: 'напомни Игорю завтра в 13:00 позвонить', originalText: 'напомни Игорю завтра в 13:00 позвонить' };
    assert.equal(await manager.handleIncoming(outsider), true);
    assert.match(String(replies.at(-1)), /доступны только Милане/iu);
});

test('forwards attachments, schedules attachment delivery, lists reminders and notifies creator on cross-user deletion', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'vk-reminder-attachments-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const copied = []; const sent = []; const replies = []; let current = now.getTime();
    const api = {
        sendMessage: async payload => { sent.push(payload); return { message_id: sent.length }; },
        copyMessage: async payload => { copied.push(payload); return { message_id: 100 + copied.length }; },
    };
    const manager = createReminderManager({ api, storagePath: join(directory, 'state.json'), ownerExternalUserId: 'owner', defaultChatId: 'milana-chat', defaultUserId: 'milana', now: () => current });
    const base = { platform: 'telegram', isDM: true, peerId: '', sourceChatId: 'owner', sourceMessageId: 77, hasAttachment: true, originalText: 'отправь Милане', text: 'отправь Милане', send: async value => replies.push(value), answerCallbackQuery: async () => {} };
    assert.equal(await manager.handleIncoming({ ...base, externalPeerId: 'owner', externalSenderId: 'owner' }), true);
    assert.equal(copied[0].fromChatId, 'owner');
    assert.equal(copied[0].messageId, 77);
    current = now.getTime();
    const scheduled = { ...base, originalText: 'отправь Милане завтра в 12:00 любой файл', text: 'отправь Милане завтра в 12:00 любой файл', externalPeerId: 'owner', externalSenderId: 'owner', sourceMessageId: 78 };
    scheduled.downloadSourceAttachment = async () => ({ buffer: Buffer.from('not-a-zip'), filename: 'note.txt', mimeType: 'text/plain' });
    assert.equal(await manager.handleIncoming(scheduled), true);
    const reminder = manager.getState().reminders.at(-1);
    assert.equal(reminder.deliveryKind, 'attachment');
    assert.equal(reminder.chatId, 'milana-chat');
    assert.equal(await manager.handleIncoming({ ...base, originalText: 'показать напоминания', text: 'показать напоминания', externalPeerId: 'owner', externalSenderId: 'owner' }), true);
    assert.equal(await manager.handleIncoming({ ...base, originalText: 'мои напоминания', text: 'мои напоминания', externalPeerId: 'owner', externalSenderId: 'owner' }), true);
    assert.ok(replies.some(value => value?.replyMarkup?.inline_keyboard?.[0]?.[0]?.text === 'Отменить навсегда'));
    const milana = { ...base, externalPeerId: 'milana-chat', externalSenderId: 'milana', originalText: '', text: '', send: async value => replies.push(value) };
    await manager.handleCallback({ ...milana, callbackQuery: { data: 'remlist:delete:' + reminder.id, message: { message_id: 1 } } });
    assert.ok(sent.some(value => value.chatId === 'owner' && /Напоминание удалено другим пользователем/iu.test(value.text)));
    assert.equal(manager.getState().reminders.find(item => item.id === reminder.id)?.deletedAt > 0, true);
});
