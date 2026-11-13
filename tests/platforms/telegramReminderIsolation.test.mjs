import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReminderManager } from '../../src/features/telegram/reminderManager.js';

test('Telegram keeps the personal flow and delivery even when VK card delivery is configured', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'gigorave-tg-isolation-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const storagePath = join(directory, 'state.json');
    let current = Date.parse('2026-10-01T08:00:00Z');
    const event = { sourceType: 'vk', id: 12, title: 'Концерт', eventDate: '2026-10-24', eventTime: '19:00', venue: 'Diesel Hall', sourceUrl: 'https://vk.ru/wall-1_2' };
    writeFileSync(storagePath, JSON.stringify({ reminders: [{ id: 'legacy', active: true, eventReminder: true, eventKey: 'vk:12', userId: '77', chatId: '77' }], edits: [] }));
    const sent = [], replies = [], vkDeliveries = [];
    const manager = createReminderManager({ storagePath, now: () => current, resolveEvent: async () => event,
        api: { sendMessage: async payload => { sent.push(payload); return { message_id: sent.length }; } },
        sendEventReminder: async payload => { vkDeliveries.push(payload); return { message_id: 10 }; },
    });
    const context = { platform: 'telegram', isDM: true, externalPeerId: '77', externalSenderId: '77', send: async value => replies.push(value), answerCallbackQuery: async () => {} };
    await manager.beginEventReminder(context, event);
    assert.equal(replies.length, 2);
    assert.equal(JSON.stringify(replies).includes('сообщениях сообщества'), false);
    let session = manager.getState().eventSessions[0];
    await manager.handleCallback({ ...context, callbackQuery: { data: 'evrem:choose:' + session.id + ':0' } });
    assert.match(replies.at(-1).message, /прежнее напоминание.*заменено/u);
    session = manager.getState().eventSessions[0];
    await manager.handleCallback({ ...context, callbackQuery: { data: 'evrem:confirm:' + session.id + ':' + session.revision } });
    assert.equal(manager.getState().reminders.find(item => item.id === 'legacy').active, false);
    current = manager.getState().reminders.find(item => item.active).nextAt;
    await manager.tick();
    assert.equal(vkDeliveries.length, 0);
    assert.match(sent[0].text, /^🔔 Напоминание: Событие: Концерт/u);
    assert.match(sent[0].text, /https:\/\/vk.ru\/wall-1_2/u);
    assert.ok(sent[0].replyMarkup.inline_keyboard.length);
    const group = { ...context, isDM: false, externalPeerId: '-10027' };
    await manager.beginEventReminder(group, event);
    assert.equal(manager.getState().eventSessions.length, 0);
    assert.equal(await manager.handleGroupEventReminder(group, event), false);
});
