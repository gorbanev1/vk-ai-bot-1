import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { MessageContext } from 'vk-io';
import { createVoiceTranscriptJobStore } from '../../src/infrastructure/database/voiceTranscriptJobs.js';
import { createVkVoiceTranscriptJobs, parseVoiceTranscriptLogCommand, formatVoiceTranscriptLog,
    vkVoiceInitialDelays, VK_VOICE_DEADLINE_MS } from '../../src/features/ai/vkVoiceTranscriptJobs.js';
import { createVkIncomingReplyContext } from '../../src/shared/incomingReplyTransport.js';
import { vkContextReferencesGroupBot } from '../../src/shared/botAddressing.js';

const descriptor = { attachmentKey: 'vk:42:99', isDirect: true, transcript: '' };
function setup({ mode = 'addressed', success = Infinity, fetchImpl, onReady, onUnavailable } = {}) {
    const db = new DatabaseSync(':memory:');
    const store = createVoiceTranscriptJobStore(db);
    let time = 1_000_000;
    const responses = [], notices = [], calls = [];
    const options = {
        store, now: () => time, random: () => 0.5,
        fetchDescriptors: async job => {
            calls.push(time);
            return fetchImpl ? fetchImpl(job) : job.requests.length >= success ? [{ ...descriptor, transcript: 'Текст голоса' }] : [];
        },
        onReady: onReady || (async job => { responses.push(job.cmid); }),
        onUnavailable: onUnavailable || (async job => { notices.push(job.cmid); }),
    };
    let worker = createVkVoiceTranscriptJobs(options);
    const input = { groupId: 123, peerId: 2000000027, cmid: 71, senderId: 42, descriptors: [descriptor], mode };
    const initial = worker.enqueue(input);
    return { db, store, calls, responses, notices, input, initial,
        job: () => store.get(initial.key),
        tick: () => worker.tick(),
        setTime: value => { time = value; },
        next: async () => { time = store.get(initial.key).nextAt; await worker.tick(); },
        enqueue: value => worker.enqueue(value),
        restart: () => { worker = createVkVoiceTranscriptJobs({ ...options, store: createVoiceTranscriptJobStore(db) }); },
    };
}

test('three initial pauses, one notice, late success replies once and logs real times', async () => {
    const h = setup({ success: 4 });
    await h.tick();
    assert.equal(h.calls.length, 0);
    await h.next(); await h.next(); await h.next();
    assert.deepEqual(h.calls.map(t => t - h.initial.receivedAt), [40000, 160000, 430000]);
    assert.deepEqual(h.notices, [71]);
    assert.deepEqual(h.responses, []);
    assert.equal(h.job().status, 'pending');
    h.restart();
    await h.next(); await h.tick();
    assert.deepEqual(h.responses, [71]);
    assert.equal(h.job().successAttempt, 4);
    assert.deepEqual(h.job().requests.map(r => r.delaySeconds), [40, 120, 270, 600]);
    assert.deepEqual(h.job().requests.map(r => r.elapsedSeconds), [40, 160, 430, 1030]);
    assert.deepEqual(h.job().requests.map(r => r.result), ['missing', 'missing', 'missing', 'found']);
    const report = formatVoiceTranscriptLog([h.job()]);
    assert.match(report, /Запросов к VK: 4/);
    assert.match(report, /на запросе №4/);
    assert.match(report, /пауза 600 с/);
    assert.match(report, /Голос не распознан/);
});

test('autonomous selection stays silent without transcript and still answers late', async () => {
    const h = setup({ mode: 'autonomous', success: 5 });
    for (let i = 0; i < 4; i++) await h.next();
    assert.deepEqual(h.notices, []);
    assert.deepEqual(h.responses, []);
    await h.next();
    assert.deepEqual(h.responses, [71]);
    assert.deepEqual(h.notices, []);
});

test('two-hour deadline expires without any guessed autonomous answer', async () => {
    const h = setup({ mode: 'autonomous' });
    while (h.job().status === 'pending') await h.next();
    assert.equal(h.job().status, 'expired');
    assert.ok(h.calls.every(t => t < h.initial.receivedAt + VK_VOICE_DEADLINE_MS));
    assert.deepEqual(h.responses, []);
    assert.deepEqual(h.notices, []);
    assert.match(formatVoiceTranscriptLog([h.job()]), /не пришёл за 2 часа/);
});

test('unselected message finishes after three checks without a notice', async () => {
    const h = setup({ mode: 'none' });
    await h.next(); await h.next(); await h.next();
    assert.equal(h.job().status, 'missing');
    assert.deepEqual(h.responses, []);
    assert.deepEqual(h.notices, []);
    await h.tick();
    assert.equal(h.calls.length, 3);
});

test('immediate transcript needs zero VK requests', async () => {
    const h = setup();
    const job = h.enqueue({ ...h.input, cmid: 72, descriptors: [{ ...descriptor, transcript: 'Уже получен' }] });
    await h.tick();
    assert.equal(h.calls.length, 0);
    assert.deepEqual(h.responses, [72]);
    assert.match(formatVoiceTranscriptLog([h.store.get(job.key)]), /Запросов к VK: 0/);
});

test('overlapping ticks and duplicate updates do not repeat request or answer', async () => {
    let release;
    const h = setup({ fetchImpl: () => new Promise(resolve => { release = resolve; }) });
    const pending = h.next();
    await h.tick();
    h.enqueue(h.input);
    assert.equal(h.calls.length, 1);
    release([{ ...descriptor, transcript: 'Результат' }]);
    await pending; await h.tick();
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.responses, [71]);
});

test('API errors count as attempts, stay in logs, and do not leak into chat', async () => {
    const h = setup({ mode: 'autonomous', fetchImpl: async () => { throw Object.assign(new Error('private credential'), { code: 5 }); } });
    await h.next();
    assert.equal(h.job().requests[0].result, 'error');
    assert.equal(h.job().requests[0].errorCode, '5');
    assert.doesNotMatch(formatVoiceTranscriptLog([h.job()]), /private credential/);
    assert.deepEqual(h.notices, []);
    assert.deepEqual(h.responses, []);
});

test('partial speech never triggers an answer and success stops later polls', async () => {
    const h = setup({ fetchImpl: async job => job.requests.length === 1
        ? [{ ...descriptor, transcript: 'Часть 1' }]
        : [{ attachmentKey: 'vk:42:100', transcript: 'Часть 2' }] });
    const job = h.job(); job.descriptors.push({ ...descriptor, attachmentKey: 'vk:42:100' }); h.store.save(job);
    await h.next(); assert.deepEqual(h.responses, []);
    assert.equal(h.job().requests[0].result, 'partial');
    await h.next(); await h.tick();
    assert.deepEqual(h.responses, [71]);
    assert.equal(h.calls.length, 2);
});

test('SQLite report isolation and command aliases', () => {
    const h = setup();
    h.enqueue({ ...h.input, peerId: 2000000003 });
    h.enqueue({ ...h.input, groupId: 555 });
    assert.equal(h.store.recent({ groupId: 123, peerId: 2000000027 }).length, 1);
    for (const value of ['транскрипт', 'транскрипты', 'транскрипт лог', '/Транскрипт!'])
        assert.equal(parseVoiceTranscriptLogCommand(value).matched, true);
    assert.equal(parseVoiceTranscriptLogCommand('транскрипт лог 71').cmid, 71);
    assert.equal(parseVoiceTranscriptLogCommand('что такое транскрипт').matched, false);
    assert.deepEqual(vkVoiceInitialDelays(() => 0), [40000, 120000, 240000]);
    assert.deepEqual(vkVoiceInitialDelays(() => 1), [40000, 120000, 300000]);
});

test('reconstructed VK context replies to original voice through real SDK', async () => {
    const sent = [];
    const context = createVkIncomingReplyContext(new MessageContext({
        api: { messages: { send: async params => {
            sent.push(params);
            return [{ peer_id: 2000000027, message_id: 500, conversation_message_id: 72 }];
        } } }, upload: {}, source: 'webhook', updateType: 'message_new', groupId: 123,
        payload: { peer_id: 2000000027, conversation_message_id: 71, from_id: 42,
            date: 12345, out: 0, reply_message: { from_id: -123, conversation_message_id: 70 } },
    }));
    assert.equal(vkContextReferencesGroupBot(context, 123), true);
    await context.send('Ответ по существу');
    const target = JSON.parse(sent[0].forward);
    assert.equal(target.peer_id, 2000000027);
    assert.equal(target.conversation_message_ids, 71);
    assert.equal(target.is_reply, true);
    await context.send('Голос не распознан.', { reply_to: 71 });
    assert.equal(sent[1].reply_to, 71);
});

import vm from 'node:vm';
import { collectVkVoiceAttachments, hasUntranscribedDirectVkVoice, normalizeVoiceTranscript,
    formatVoiceTranscriptBlock } from '../../src/features/ai/voiceTranscription.js';
import { getVkRawMessage, extractVkMessageContent } from '../../src/platforms/vk/vkMessageContent.js';
import { createBotMentionTools } from '../../src/shared/commands.js';
const appSource = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const sourceFunction = (start, end) => appSource.slice(appSource.indexOf(start), appSource.indexOf(end, appSource.indexOf(start)));

test('VK handler selects voice once and never starts response code without transcript', async () => {
    const queued = new Map(), selected = [], replies = [], saved = [];
    let requestRuns = 0;
    const mention = createBotMentionTools({ groupId: 123 });
    const dependencies = {
        console: { log() {}, warn() {}, error() {} }, Date,
        createVkIncomingReplyContext: value => value,
        getVkRawMessage, collectVkVoiceAttachments, hasUntranscribedDirectVkVoice,
        normalizeVoiceTranscript, formatVoiceTranscriptBlock, extractVkMessageContent,
        resolveVkMessageContent: async raw => extractVkMessageContent(raw), vk: { api: {} },
        isPrivateContext: () => false, containsBotMention: mention.containsBotMention,
        contextReferencesBot: context => vkContextReferencesGroupBot(context, 123),
        getActiveVkConnection: () => ({ groupId: 123 }),
        voiceTranscriptJobs: { get: key => queued.get(key) },
        maybeHandleActiveCommunication: (...args) => { selected.push(args); return true; },
        resolveVkVoiceTranscriptsForMessage: async () => [],
        mergeVoiceDescriptors: values => values,
        getActiveBehaviorEpoch: () => 0,
        vkVoiceJobs: { enqueue: job => queued.set([job.groupId, job.peerId, job.cmid].join(':'), job), tick: async () => {} },
        registerCommunicationParticipant() {}, archiveVkMessageFromMessage() {},
        saveIncomingMessage: value => saved.push(value),
        getRequestDate: () => new Date(100000),
        runWithIncomingGptRequest: async (_ctx, _text, callback) => { requestRuns++; return callback(); },
        isAutonomousCommunicationEnabled: () => true, getCommunicationSettings: () => ({}),
        isActiveBehaviorEpochCurrent: () => true,
        scheduleActiveCommunicationReply: async (...args) => { replies.push(args); return true; },
        queueVkChatEventAnalysis() {},
    };
    const handler = vm.runInNewContext(sourceFunction('async function handleVkIncomingMessageCore',
        'async function handleVkIncomingMessage(incomingContext)') + '\nhandleVkIncomingMessageCore', dependencies);
    const context = { peerId: 2000000027, conversationMessageId: 71, senderId: 42, text: '',
        message: { attachments: [{ type: 'audio_message', audio_message: { owner_id: 42, id: 99 } }] } };
    await Promise.all([handler(context), handler(context)]);
    assert.equal(queued.size, 1);
    assert.equal(selected.length, 1);
    assert.equal(selected[0][2].deferVoice, true);
    assert.equal(requestRuns, 0);
    const job = [...queued.values()][0];
    assert.equal(job.mode, 'autonomous');
    await handler(context, { voiceJob: job });
    assert.equal(requestRuns, 0, 'missing transcript cannot fall into GPT/context reply');
    job.descriptors[0].transcript = 'Теперь есть реальные слова';
    await handler(context, { voiceJob: job });
    assert.equal(replies.length, 1);
    assert.match(replies[0][1], /Теперь есть реальные слова/);
    assert.equal(replies[0][2], 0);
    assert.equal(replies[0][3].preservePending, true);
    assert.equal(saved.length, 1);
    assert.equal(selected.length, 1, 'late transcript does not reroll autonomous selection');
    await handler({ ...context, conversationMessageId: 72, text: '[club123|Гигорейв]' });
    assert.equal(queued.get('123:2000000027:72').mode, 'addressed');
    assert.equal(selected.length, 1, 'mention never enters autonomous counter');
});

test('active-chat counter can select a pending voice without generating anything', () => {
    let counter = 0;
    const responses = [];
    const dependencies = {
        console: { log() {} }, Date,
        getRawContext: value => value, isPrivateContext: () => false,
        containsBotMention: () => false, contextReferencesBot: () => false,
        isEligibleActiveCommunicationMessage: text => text.length > 1,
        getActiveBehaviorEpoch: () => 0,
        getCommunicationSettings: () => ({ activeChatMessageCount: counter, activeChatInterval: 2 }),
        isAutonomousCommunicationEnabled: () => true,
        consumeActiveCommunicationCounterValue: count => ({ nextCount: count + 1, shouldReply: count === 1 }),
        updateActiveCommunicationState: value => { counter = value.messageCount; },
        updateActiveCommunicationHealth() {},
        scheduleActiveCommunicationReply: (...args) => responses.push(args),
    };
    const fn = vm.runInNewContext(sourceFunction('function maybeHandleActiveCommunication(',
        'async function runActiveCommunicationReply(') + '\nmaybeHandleActiveCommunication', dependencies);
    assert.equal(fn({ peerId: 27 }, '', { deferVoice: true }), false);
    assert.equal(fn({ peerId: 27 }, '', { deferVoice: true }), true);
    assert.equal(counter, 2);
    assert.deepEqual(responses, []);
});

test('log command uses current chat and explicit/replied voice, with no AI routing', async () => {
    const h = setup();
    await h.next();
    const mention = createBotMentionTools({ groupId: 123 });
    const output = [];
    const dependencies = {
        parseVoiceTranscriptLogCommand, formatVoiceTranscriptLog, voiceTranscriptJobs: h.store,
        parseIncomingCommand: (text, parser) => parser(mention.removeBotMentions(text)).matched
            ? { matched: true, parsed: parser(mention.removeBotMentions(text)) } : { matched: false },
        getActiveVkConnection: () => ({ groupId: 123 }),
        getReplyConversationMessageId: context => context.replyId,
        botTimeZone: 'Europe/Moscow', splitLines: lines => [lines.join('\n')],
    };
    const handler = vm.runInNewContext(sourceFunction('async function maybeHandleVoiceTranscriptLog(',
        'async function handleVkIncomingMessageCore(') + '\nmaybeHandleVoiceTranscriptLog', dependencies);
    const context = { peerId: 2000000027, send: async text => output.push(text) };
    assert.equal(await handler(context, 'транскрипты'), true);
    assert.match(output.at(-1), /ГС #71/);
    assert.match(output.at(-1), /Запросов к VK: 1/);
    assert.equal(await handler({ ...context, replyId: 71 }, 'Гигорейв, транскрипт'), true);
    assert.match(output.at(-1), /ГС #71/);
    assert.equal(await handler({ ...context, replyId: 100 }, 'транскрипт'), true);
    assert.match(output.at(-1), /ГС #71/, 'replying to bot report must fall back to recent voice logs');
    await handler(context, 'транскрипт 900');
    assert.match(output.at(-1), /нет голосового #900/);
    await handler({ ...context, peerId: 2000000003 }, 'транскрипт');
    assert.match(output.at(-1), /пока пуст/);
    assert.equal(await handler(context, 'что значит транскрипт'), false);
});

test('finished jobs stay finished after reopening SQLite store and failed delivery stays visible', async () => {
    const h = setup({ success: 1, onReady: async () => { throw Error('send failed'); } });
    await h.next();
    h.restart(); await h.tick();
    assert.equal(h.calls.length, 1);
    assert.equal(h.job().status, 'delivery_error');
    assert.match(formatVoiceTranscriptLog([h.job()]), /ошибка обработки ответа/);
});
