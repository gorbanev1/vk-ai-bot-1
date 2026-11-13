import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
function load(name, dependencies) {
    const start = source.indexOf(`async function ${name}(`);
    assert.ok(start >= 0);
    const end = source.indexOf('\n}\n', start) + 2;
    return new Function(...Object.keys(dependencies), `return (${source.slice(start, end)});`)(...Object.values(dependencies));
}

test('mention analysis awaits worker and preserves incomplete status when no matches were found', async () => {
    let searched = false;
    const analyze = load('analyzeParticipantMentionDatabaseMessages', {
        PARTICIPANT_MENTION_RAW_MESSAGE_BUDGET: 2000,
        PARTICIPANT_NAME_PART_MIN_SCORE: 0.8,
        getRawContext: value => value,
        loadLinkedSummaryHistory: () => [{senderId: 20, text: 'test'}],
        filterChatDatabaseMessages: value => value,
        findParticipantMentionMatchesAsync: async () => {
            searched = true;
            return {matches: [], complete: false, reason: 'timeout', scannedCount: 0, totalCount: 1};
        },
    });
    const result = await analyze({context: {peerId: 6}, target: {userId: 10}});
    assert.equal(searched, true);
    assert.equal(result.searchStatus.complete, false);
    assert.equal(result.searchStatus.reason, 'timeout');
});

function answerHarness({own = true, complete = false} = {}) {
    const sent = [];
    const prompts = [];
    const participant = {userId: 10, displayName: 'Тестовый Участник'};
    const answer = load('trySendParticipantDatabaseAnswer', {
        isPrivateContext: () => false,
        looksLikeBotSelfTargetQuestion: () => false,
        collectStoredChatParticipants: async () => [participant],
        resolveParticipantQuestionTarget: () => ({matched: true, participant, matchedPhrase: 'Тестовый', score: 1}),
        mergeResolvedParticipantIdentity: () => ({participant}),
        analyzeParticipantDatabaseMessages: async () => ({messages: own ? [{}] : [], evidence: own ? 'Собственные сообщения.' : ''}),
        analyzeParticipantMentionDatabaseMessages: async () => ({matches: [], searchStatus: {complete, reason: complete ? 'complete' : 'timeout', scannedCount: 128, totalCount: 1000}}),
        normalizeLocalCommand: value => String(value).toLowerCase(),
        enqueueOpenAI: operation => operation(),
        generateOpenAIText: async prompt => { prompts.push(prompt); return 'Тестовый ответ.'; },
        getCommunicationStylePrompt: () => '',
        recordInteraction: () => {},
        sendLong: async (_context, text) => sent.push(text),
        visibleTextModelHeader: () => '',
        SUMMARY_USER_RAW_MESSAGE_HARD_LIMIT: 4000,
    });
    return {sent, prompts, run: () => answer({context: {send: async text => sent.push(text)}, userRequest: 'Что о нём известно?', model: 'test'})};
}

test('partial search is disclosed both to the model and in the delivered answer', async () => {
    const harness = answerHarness();
    assert.equal(await harness.run(), true);
    assert.match(harness.prompts[0].userPrompt, /проверено 128 из 1000/u);
    assert.match(harness.sent[0], /не полностью/u);
    assert.doesNotMatch(harness.sent[0], /Поиск по всей базе/u);
});

test('empty partial result does not become a claim that the archive has no mentions', async () => {
    const harness = answerHarness({own: false});
    assert.equal(await harness.run(), true);
    assert.equal(harness.prompts.length, 0);
    assert.match(harness.sent[0], /Отсутствие других упоминаний не подтверждено/u);
    assert.doesNotMatch(harness.sent[0], /нет ни его собственных сообщений, ни сообщений/u);
});

test('complete search retains full-history status', async () => {
    const harness = answerHarness({complete: true});
    await harness.run();
    assert.match(harness.sent[0], /Поиск по всей базе/u);
    assert.doesNotMatch(harness.sent[0], /не полностью/u);
});
