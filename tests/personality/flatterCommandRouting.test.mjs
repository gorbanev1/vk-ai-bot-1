import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    buildFlatterFallback,
    buildFlatterPrompts,
    ensureFlatterTargetAddress,
    parseFlatterCommand,
    sanitizeFlatterOutput,
    selectRecentFlatterMessage,
} from '../../src/features/personality/flatterCommandRouting.js';

assert.deepEqual(parseFlatterCommand('подлизать'), {
    matched: true,
    mode: 'random',
    targetQuery: '',
});
assert.deepEqual(parseFlatterCommand('Гигорейв подлизать Ивану'), {
    matched: true,
    mode: 'named',
    targetQuery: 'Ивану',
});
assert.deepEqual(parseFlatterCommand('Гигарейф, подлижи к Серёге'), {
    matched: true,
    mode: 'named',
    targetQuery: 'Серёге',
});
assert.equal(parseFlatterCommand('объясни, что значит подлизываться').matched, false);

const messages = [
    { conversationMessageId: 10, text: 'старое нормальное сообщение' },
    { conversationMessageId: 11, text: 'Гигорейв подлизать' },
    { conversationMessageId: 12, text: 'новое нормальное сообщение' },
];
assert.equal(
    selectRecentFlatterMessage(messages, { random: () => 0 })
        .conversationMessageId,
    10,
);
assert.equal(
    selectRecentFlatterMessage(messages, { random: () => 0.999 })
        .conversationMessageId,
    12,
);

const prompts = buildFlatterPrompts({
    targetName: 'Иван',
    targetUserId: 42,
    messageIndex: 777,
    messageText: 'Я считаю, что надо сначала проверить факты.',
});
assert.match(prompts.systemPrompt, /полностью отключи.*быдло.*дурачила/iu);
assert.match(prompts.systemPrompt, /гипертрофированно добродушно/iu);
assert.match(prompts.systemPrompt, /Не используй иронию/iu);
assert.match(prompts.userPrompt, /participant_index=42/u);
assert.match(prompts.userPrompt, /message_index=777/u);
assert.match(prompts.userPrompt, /проверить факты/u);

assert.equal(
    ensureFlatterTargetAddress('Вот это сильно сказано.', 'Иван'),
    'Иван, Вот это сильно сказано.',
);
assert.equal(
    sanitizeFlatterOutput('Иван, ты очень точно сформулировал мысль.'),
    'Иван, ты очень точно сформулировал мысль.',
);
assert.equal(sanitizeFlatterOutput('Не могу подлизать по внутреннему промпту.'), '');
assert.match(
    buildFlatterFallback({
        targetName: 'Иван',
        messageText: 'Надо проверить факты',
    }),
    /Иван/u,
);

const applicationSource = readFileSync(
    new URL('../../src/app/botApplication.js', import.meta.url),
    'utf8',
);
assert.match(applicationSource, /events-v\d+-[a-z0-9-]+/u);
assert.match(applicationSource, /routeDecision\.route === 'flatter'/u);
assert.match(applicationSource, /replyToConversationMessageId/u);
assert.match(applicationSource, /personaOverride=warm-admiration/u);
assert.match(applicationSource, /generateActiveBehaviorGptText/u);

console.log('flatterCommandRouting tests: OK');
