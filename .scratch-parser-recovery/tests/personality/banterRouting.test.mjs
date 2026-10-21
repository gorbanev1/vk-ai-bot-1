import assert from 'node:assert/strict';

import {
    buildAttackClassifierPrompts,
    buildBanterReplyPrompts,
    classifyAttackHeuristically,
    isDirectPersonaProvocation,
    parseAttackClassifierResponse,
    shouldKeepBanterActive,
} from '../../src/features/personality/banterRouting.js';

assert.equal(
    classifyAttackHeuristically('гигорейв соси хуй', { directedAtBot: true }).result,
    'yes',
);
assert.equal(
    classifyAttackHeuristically('ладно, понял', { directedAtBot: true }).result,
    'no',
);
assert.equal(parseAttackClassifierResponse('ATTACK'), true);
assert.equal(parseAttackClassifierResponse('NO'), false);
assert.equal(isDirectPersonaProvocation('покажи анус'), true);
assert.equal(isDirectPersonaProvocation('объясни анатомию человека'), false);
assert.equal(parseAttackClassifierResponse('непонятно'), null);
assert.equal(shouldKeepBanterActive({ now: 10, activeUntil: 20, replyCount: 2 }), true);
assert.equal(shouldKeepBanterActive({ now: 21, activeUntil: 20, replyCount: 2 }), false);
assert.equal(shouldKeepBanterActive({ now: 10, activeUntil: 20, replyCount: 8 }), false);

const classifier = buildAttackClassifierPrompts({
    text: 'ты клоун',
    directedAtBot: true,
});
assert.match(classifier.systemPrompt, /ATTACK/u);

const reply = buildBanterReplyPrompts({
    persona: 'bydlo',
    targetName: 'Сева',
    incomingText: 'соси хуй',
    replyCount: 3,
});
assert.match(reply.systemPrompt, /максимально грубо/u);
assert.match(reply.systemPrompt, /продолжение перепалки/u);
assert.match(reply.userPrompt, /Сева/u);

const stupidReply = buildBanterReplyPrompts({
    persona: 'durachila',
    targetName: 'Игорь',
    incomingText: 'ты не понял',
    replyCount: 1,
});
assert.match(stupidReply.systemPrompt, /откровенно тупо/u);
assert.match(stupidReply.systemPrompt, /Не пиши сюрреализм/u);

console.log('banterRouting tests: OK');
