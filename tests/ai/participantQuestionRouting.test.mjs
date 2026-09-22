import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
    findParticipantMentionMatches,
    looksLikeBotSelfTargetQuestion,
    looksLikeParticipantQuestion,
    resolveParticipantQuestionTarget,
    resolveParticipantReferenceTarget,
} from '../../src/features/ai/participantQuestionRouting.js';

const participants = [
    {
        userId: 10,
        displayName: 'Тимофей Тимофеев',
        aliases: ['Тимофей', 'Timofey'],
        lastSeenAt: 100,
    },
    {
        userId: 11,
        displayName: 'Александр Егоров',
        aliases: ['Саша'],
        lastSeenAt: 200,
    },
    {
        userId: 12,
        displayName: 'Денни Гринн',
        aliases: ['Denny'],
        lastSeenAt: 300,
    },
];

test('recognizes a question about a participant', () => {
    assert.equal(
        looksLikeParticipantQuestion('почему Тимосин всё время хочет пиздеться?'),
        true,
    );
});


test('does not route a question about the bot itself to a chat participant', () => {
    const question = 'у тебя прл? если нет, скажи свой психиатрический диагноз, опираясь на все свои сообщения';
    const result = resolveParticipantQuestionTarget(question, [
        ...participants,
        {
            userId: 13,
            displayName: 'Михаил Витасепт',
            aliases: ['Михаил'],
            lastSeenAt: 400,
        },
    ]);

    assert.equal(looksLikeBotSelfTargetQuestion(question), true);
    assert.equal(looksLikeParticipantQuestion(question), false);
    assert.equal(result.matched, false);
    assert.equal(result.participant, null);
});

test('normalizes stop words before fuzzy comparison', () => {
    const result = resolveParticipantQuestionTarget(
        'почему все свои сообщения такие странные?',
        [
            {
                userId: 13,
                displayName: 'Михаил Витасепт',
                aliases: ['Михаил'],
                lastSeenAt: 400,
            },
        ],
    );

    assert.equal(result.matched, false);
    assert.notEqual(result.matchedPhrase, 'все');
});

test('maps Тимосин to Тимофей by maximum fuzzy similarity', () => {
    const result = resolveParticipantQuestionTarget(
        'почему Тимосин всё время хочет пиздеться?',
        participants,
    );

    assert.equal(result.matched, true);
    assert.equal(result.participant.userId, 10);
    assert.equal(result.matchedPhrase, 'Тимосин');
    assert.ok(result.score >= 0.76);
});


test('resolves a plain dossier nickname without requiring a question sentence', () => {
    const result = resolveParticipantReferenceTarget(
        'тимасин',
        [
            {
                userId: 10,
                displayName: 'Тимофей Тимофеев',
                aliases: ['Тимофей', '@timasin228'],
                lastSeenAt: 100,
            },
            participants[1],
        ],
        { minimumScore: 0.78 },
    );

    assert.equal(result.matched, true);
    assert.equal(result.participant.userId, 10);
    assert.ok(result.score >= 0.78);
});

test('supports VK direct mentions', () => {
    const result = resolveParticipantQuestionTarget(
        'почему [id11|Саша] так отвечает?',
        participants,
    );

    assert.equal(result.matched, true);
    assert.equal(result.participant.userId, 11);
    assert.equal(result.score, 1);
});

test('does not route an unrelated factual question', () => {
    const result = resolveParticipantQuestionTarget(
        'почему небо синее?',
        participants,
    );

    assert.equal(result.matched, false);
});


test('finds messages by fuzzy form, real name and VK mention while excluding target author', () => {
    const target = {
        ...participants[0],
        externalUserId: '10',
        aliases: ['Тимофей', 'Timofey', '@timofey_live'],
    };
    const messages = [
        { senderId: 20, text: 'Тимосин опять начал спорить', conversationMessageId: 1 },
        { senderId: 21, text: 'Тимофей сегодня был спокойный', conversationMessageId: 2 },
        { senderId: 22, text: 'Я отвечал [id10|Тимофею] вчера', conversationMessageId: 3 },
        { senderId: 23, text: '@timofey_live, ты придёшь?', conversationMessageId: 4 },
        { senderId: 10, text: 'Тимосин — это я', conversationMessageId: 5 },
        { senderId: 24, text: 'Вообще не про него', conversationMessageId: 6 },
    ];
    const matches = findParticipantMentionMatches(
        messages,
        target,
        'Тимосин',
    );

    assert.deepEqual(
        matches.map((match) => match.message.conversationMessageId),
        [1, 2, 3, 4],
    );
    assert.equal(matches.some((match) => match.message.senderId === 10), false);
});

test('finds an inflected first name by fuzzy similarity', () => {
    const matches = findParticipantMentionMatches(
        [{ senderId: 20, text: 'Вчера без Тимофея было тихо' }],
        participants[0],
        'Тимосин',
    );

    assert.equal(matches.length, 1);
    assert.equal(matches[0].matchedText, 'Тимофея');
    assert.ok(matches[0].score >= 0.82);
});


test('orchestrator keeps own messages and third-party mentions in separate evidence blocks', () => {
    const source = readFileSync(
        new URL('../../src/app/botApplication.js', import.meta.url),
        'utf8',
    );

    assert.match(source, /analyzeParticipantMentionDatabaseMessages/u);
    assert.match(source, /findParticipantMentionMatches/u);
    assert.match(source, /БЛОК A — РЕЛЕВАНТНЫЕ МАТЕРИАЛЫ ИЗ СОБСТВЕННЫХ СООБЩЕНИЙ/u);
    assert.match(source, /БЛОК B — РЕЛЕВАНТНЫЕ МАТЕРИАЛЫ ИЗ СООБЩЕНИЙ ДРУГИХ ЛЮДЕЙ/u);
    assert.match(source, /упоминаний другими людьми/u);
    assert.match(source, /events-v\d+-[a-z0-9-]+/u);
    assert.match(
        source,
        /parsed\.action === 'chat' &&\s*astrologyKind === 'none' &&\s*await trySendParticipantDatabaseAnswer/su,
    );
    assert.match(source, /resolveDossierTarget\(context, requestText\)/u);
    assert.match(source, /buildDossierFromStoredMessages/u);
    assert.match(source, /досье <имя, ник или @username>/u);
});
