import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createParticipantMentionSearch, findParticipantMentionMatchesAsync } from '../../src/features/ai/participantMentionSearch.js';
import { findParticipantMentionMatches, buildParticipantMentionContextWindows } from '../../src/features/ai/participantQuestionRouting.js';
import { createParticipantNamePartScorer, participantNamePartSimilarity } from '../../src/features/personality/roastCommandRouting.js';

const target = {userId: 10, userIds: [10, 30], displayName: 'Тимофей Тимофеев', aliases: ['Timofey', '@timofey_live']};
const fixture = new URL('../fixtures/participantMentionWorkerFixture.mjs', import.meta.url);
const messages = Array.from({length: 700}, (_, index) => ({
    senderId: index % 10 === 0 ? 30 : 20,
    text: ['Вчера без Тимофея было тихо', 'Что нового?', '[id10|Имя] привет', '@timofey_live, заходи'][index % 4],
    conversationMessageId: index,
}));

test('compiled scores preserve inflections, the strict threshold and identity bridges', () => {
    for (const participant of [target, {displayName: 'Святой Котец'}, {displayName: 'Тимофей Другой'}, {displayName: 'Кирюша Атон', aliases: ['Кирилл']}]) {
        const score = createParticipantNamePartScorer(participant);
        for (const phrase of ['Тимасина', 'Тимофея', 'Тимофей Другой', 'Святои', 'связь', 'Кирюши', 'Атона', 'неизвестное слово', 'новости', '']) {
            assert.equal(score(phrase), participantNamePartSimilarity(phrase, participant), phrase);
        }
    }
});

test('worker returns the same matches, chronological order and original message identities', async () => {
    const result = await findParticipantMentionMatchesAsync(messages, target, 'Тимосин');
    assert.equal(result.complete, true);
    assert.equal(result.scannedCount, messages.length);
    assert.deepEqual(result.matches, findParticipantMentionMatches(messages, target, 'Тимосин'));
    for (const match of result.matches) assert.strictEqual(match.message, messages[match.message.conversationMessageId]);
    const windows = buildParticipantMentionContextWindows(messages, result.matches);
    assert.ok(windows.length);
});

test('large history does not block timers in the main event loop', async () => {
    const corpus = Array.from({length: 15000}, (_, i) => ({senderId: 20, text: `Новости музыки номер ${i} и обычный разговор без нужного имени`}));
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    try {
        const result = await findParticipantMentionMatchesAsync(corpus, {userId: 10, displayName: 'Кирюша Атон'});
        assert.equal(result.complete, true);
        assert.ok(ticks > 10, `main event loop ticks: ${ticks}`);
    } finally { clearInterval(timer); }
});

test('deadline terminates CPU work and the next queued request can run', async () => {
    const search = createParticipantMentionSearch({workerUrl: fixture});
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    try {
        const stuck = search(messages, {mode: 'hang'}, '', {timeoutMs: 350});
        const next = search(messages, {});
        const result = await stuck;
        assert.equal(result.reason, 'timeout');
        assert.equal(result.complete, false);
        assert.ok(ticks > 5);
        assert.equal((await next).complete, true);
    } finally { clearInterval(timer); }
});

test('partial timeout reports scanned count without claiming the whole archive was searched', async () => {
    const search = createParticipantMentionSearch({workerUrl: fixture});
    const result = await search(messages, {mode: 'partial'}, '', {timeoutMs: 350});
    assert.equal(result.reason, 'timeout');
    assert.ok(result.scannedCount > 0 && result.scannedCount < messages.length);
});

test('queue overload, cancellation and queued deadlines are bounded', async () => {
    const search = createParticipantMentionSearch({workerUrl: fixture, maxQueued: 1});
    const controller = new AbortController();
    const first = search(messages, {mode: 'hang'}, '', {signal: controller.signal});
    const second = search(messages, {}, '', {timeoutMs: 40});
    assert.equal((await search(messages, {})).reason, 'busy');
    assert.equal((await second).reason, 'timeout');
    controller.abort();
    assert.equal((await first).reason, 'aborted');
    assert.equal((await search(messages, {})).complete, true);
});

test('worker errors and unexpected clean exits release the slot without synchronous fallback', async () => {
    const search = createParticipantMentionSearch({workerUrl: fixture});
    assert.equal((await search(messages, {mode: 'error'})).reason, 'worker-error');
    assert.equal((await search(messages, {mode: 'exit'})).reason, 'worker-exit');
    assert.equal((await search(messages, {})).complete, true);
});

test('empty inputs and pre-cancelled requests do not start a scan', async () => {
    const controller = new AbortController(); controller.abort();
    assert.equal((await findParticipantMentionMatchesAsync(messages, target, '', {signal: controller.signal})).reason, 'aborted');
    assert.equal((await findParticipantMentionMatchesAsync([], target)).complete, true);
});
