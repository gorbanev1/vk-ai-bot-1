import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    buildAiTargetSelectionPrompts,
    buildHyperbolicPersonaInstruction,
    buildSafeRoastFallback,
    chooseAiRankedParticipant,
    filterRoastMessagesByWindow,
    selectRoastContextMessages,
    normalizeParticipantAlias,
    normalizedNameSimilarity,
    parseAiTargetRanking,
    parseRoastCommand,
    resolveLocalParticipantMatch,
    sanitizeRoastOutput,
    transliterateRussian,
} from '../../src/features/personality/roastCommandRouting.js';

assert.deepEqual(parseRoastCommand('доебаться'), {
    matched: true,
    mode: 'random',
    targetQuery: '',
});
assert.deepEqual(parseRoastCommand('Гигорейв фас Иван'), {
    matched: true,
    mode: 'named',
    targetQuery: 'Иван',
});
assert.equal(parseRoastCommand('объясни фасад здания').matched, false);
assert.deepEqual(parseRoastCommand('доебись до Серёги'), {
    matched: true,
    mode: 'named',
    targetQuery: 'Серёги',
});
assert.deepEqual(parseRoastCommand('фас: Ivan Petrov'), {
    matched: true,
    mode: 'named',
    targetQuery: 'Ivan Petrov',
});


const now = 1_000_000;
const windowedMessages = filterRoastMessagesByWindow([
    { createdAt: now - 60, text: 'свежее' },
    { createdAt: now - 24 * 60 * 60, text: 'ровно сутки' },
    { createdAt: now - 24 * 60 * 60 - 1, text: 'старое' },
    { createdAt: now + 60, text: 'небольшой дрейф часов' },
    { createdAt: now + 10 * 60, text: 'слишком будущее' },
], { now });
assert.deepEqual(windowedMessages.map((message) => message.text), [
    'свежее',
    'ровно сутки',
    'небольшой дрейф часов',
]);

assert.equal(transliterateRussian('Ёжик Юра'), 'ezhik yura');
assert.equal(normalizeParticipantAlias('@Иван_Иванов'), 'ivan ivanov');
assert.ok(normalizedNameSimilarity('Алексей', 'Aleksei') >= 0.9);

const participants = [
    {
        userId: 1,
        displayName: 'Иван Петров',
        aliases: ['@ivan_petrov'],
        lastSeenAt: 100,
    },
    {
        userId: 2,
        displayName: 'Иван Петрович',
        aliases: ['@ivan_p'],
        lastSeenAt: 300,
    },
    {
        userId: 3,
        displayName: 'Сергей Сидоров',
        aliases: ['Serega'],
        lastSeenAt: 200,
    },
];

assert.equal(
    resolveLocalParticipantMatch('Serega', participants).participant.userId,
    3,
);
assert.equal(
    resolveLocalParticipantMatch('[id1|Иван]', participants).participant.userId,
    1,
);

const tied = resolveLocalParticipantMatch('Иван', participants);
assert.equal(tied.participant.userId, 2);
assert.equal(tied.source, 'local-recent-tiebreak');

const fullName = resolveLocalParticipantMatch('Иван Петров', participants);
assert.equal(fullName.participant.userId, 1);
assert.equal(fullName.source, 'local-fuzzy');

const prompts = buildAiTargetSelectionPrompts({
    query: 'Саня',
    participants,
});
assert.match(prompts.systemPrompt, /транслитерац/iu);
assert.match(prompts.userPrompt, /lastSeenAt/u);

const aiRanking = parseAiTargetRanking(
    '[{"userId":1,"confidence":0.8},{"userId":2,"confidence":0.82}]',
    participants,
);
assert.equal(aiRanking.length, 2);
assert.equal(
    chooseAiRankedParticipant(aiRanking).participant.userId,
    2,
);

assert.match(buildHyperbolicPersonaInstruction('bydlo'), /гипертрофирован/iu);
assert.match(buildHyperbolicPersonaInstruction('politician'), /комисси/iu);
assert.match(buildSafeRoastFallback({ persona: 'durachila', targetName: 'Паша' }), /Паша/u);

assert.equal(sanitizeRoastOutput('Паша, аргументов опять не завезли.'), 'Паша, аргументов опять не завезли.');
assert.equal(sanitizeRoastOutput('Я найду тебя и сломаю твой телефон'), '');
assert.equal(sanitizeRoastOutput('Телефон: +79991234567'), '');

const applicationSource = readFileSync(
    new URL('../../src/app/botApplication.js', import.meta.url),
    'utf8',
);
assert.match(applicationSource, /events-v\d+-[a-z0-9-]+/u);
assert.match(applicationSource, /routeDecision\.route === 'roast'/u);
assert.match(applicationSource, /selectRoastContextMessages\([\s\S]*getRecentParticipantMessages/u);
assert.match(applicationSource, /ROAST_TARGET_COOLDOWN_SECONDS = 2 \* 60 \* 60/u);
assert.match(applicationSource, /buildHyperbolicPersonaInstruction\(settings\.persona\)/u);
assert.match(applicationSource, /const referencesBot = contextReferencesBot\(context\)/u);
assert.match(applicationSource, /!mentioned && !referencesBot/u);

assert.match(applicationSource, /messages\.getConversationMembers/u);
assert.match(applicationSource, /name-only-fallback/u);
assert.match(applicationSource, /За последние 24 часа сообщений цели нет/u);
assert.match(applicationSource, /resolveExplicitVkRoastParticipant/u);

console.log('roastCommandRouting tests: OK');
