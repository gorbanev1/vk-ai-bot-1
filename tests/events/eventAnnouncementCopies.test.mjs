import test from 'node:test';
import assert from 'node:assert/strict';
import { configureEventAnnouncementCopies, prepareEventAnnouncementCopies, selectEventAnnouncement, cleanOriginalEventAnnouncement, getOriginalEventAnnouncement } from '../../src/features/events/eventAnnouncementCopies.js';

test('keeps original paragraphs and facts; caches both summaries without rewriting a fitting original', async () => {
    const stored = new Map(); let calls = 0;
    configureEventAnnouncementCopies({ render: (e, p, text) => e.title + '\n' + text, load: key => stored.get(key), save: (key, value) => stored.set(key, value),
        edit: async () => { calls++; return { shortSummary: 'Первый абзац.\n\nВторой абзац.', ultraShortSummary: 'Раз. Два. Три.' }; } });
    const original = 'Мой точный текст & эмодзи 🎸.\n\nВремя: 18:00.\nМесто: лес.\n\nНе удаляй ни одного предложения.';
    const [event] = await prepareEventAnnouncementCopies([{ title: 'Самайн', description: 'ИИ выжимка' }], { sourceText: original });
    assert.equal(event.description, original);
    assert.equal(selectEventAnnouncement(event, 'vk'), original);
    assert.equal(selectEventAnnouncement(event, 'telegram'), original);
    await prepareEventAnnouncementCopies([event]);
    assert.equal(calls, 1);
    assert.ok([...stored.values()][0].shortSummary.includes('\n\n'));
});

test('uses the strict shared platform budget, including newlines and VK markup', async () => {
    const stored = new Map(); let request;
    const original = 'Содержательное предложение. '.repeat(130).trim();
    configureEventAnnouncementCopies({
        render: (e, platform, text) => 'Ш'.repeat(platform === 'vk' ? 800 : 100) + '\n\n' + text,
        markupExpansion: () => 50, load: key => stored.get(key), save: (key, value) => stored.set(key, value),
        edit: async input => { request = input; return { vk: 'Сокращённый текст. '.repeat(130), telegram: 'Связный телеграм-анонс.', shortSummary: 'Развёрнутая копия.', ultraShortSummary: 'Раз. Два. Три.' }; },
    });
    const [event] = await prepareEventAnnouncementCopies([{ description: original }]);
    assert.equal(request.budgets.vk, 898);
    assert.equal(request.budgets.telegram, 898);
    assert.equal(selectEventAnnouncement(event, 'telegram'), 'Связный телеграм-анонс.');
    assert.equal(selectEventAnnouncement(event, 'vk'), 'Связный телеграм-анонс.');
    assert.equal(event.description, original);
});

test('multi-event posts keep their own segment and failed editors never corrupt or cut the original mid-sentence', async () => {
    configureEventAnnouncementCopies({ render: (e,p,text) => text, edit: async () => ({ vk: 'x'.repeat(9999) }) });
    const original = 'Полное законченное предложение. '.repeat(150);
    const [event] = await prepareEventAnnouncementCopies([{ isMultiAnnouncement: true, sourceSegment: original }], { sourceText: 'Чужой концерт.' });
    assert.equal(event.description, original.trim());
    assert.throws(() => selectEventAnnouncement(event, 'vk'), { code: 'EVENT_CARD_PREPARATION_PENDING' });
    assert.equal(getOriginalEventAnnouncement({ isMultiAnnouncement: true, sourceSegment: 'Моя глава.', sourceText: 'Чужая.' }), 'Моя глава.');
});

test('removes captured author and reaction UI while preserving the source body', () => {
    assert.equal(cleanOriginalEventAnnouncement('https://vk.ru/wall1_2\n\nСима и ещё 2 автора Действия Старый лес. Встретимся у костра! Оценили 2 человека Лайк Отправить реакцию'), 'Старый лес. Встретимся у костра!');
});

test('multiple returned events retain segment identity after persistence and source contact links remain intact', async () => {
    configureEventAnnouncementCopies({ render: (e,p,text) => text, edit: async () => null });
    const [first, second] = await prepareEventAnnouncementCopies([{ description: 'Первый концерт.\nhttps://t.me/tickets' }, { description: 'Второй концерт.' }], { sourceText: 'Общий пост о двух концертах.' });
    assert.equal(first.isMultiAnnouncement, true);
    assert.equal(first.sourceSegment, 'Первый концерт.\nhttps://t.me/tickets');
    assert.equal(getOriginalEventAnnouncement({ ...first, sourceText: 'Общий пост' }), first.sourceSegment);
    assert.equal(getOriginalEventAnnouncement({ ...second, sourceText: 'Общий пост' }), 'Второй концерт.');
});
