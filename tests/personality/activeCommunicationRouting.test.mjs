import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import {
    buildActiveCommunicationModelModeChain,
    buildActiveCommunicationPrompts,
    chooseActiveCommunicationTargetOffset,
    chooseRandomActiveCommunicationPersona,
    consumeActiveCommunicationCounterValue,
    isEligibleActiveCommunicationMessage,
    parseActiveCommunicationCommand,
} from '../../src/features/personality/activeCommunicationRouting.js';

assert.deepEqual(
    parseActiveCommunicationCommand('активное общение'),
    { matched: true, action: 'enable' },
);
assert.deepEqual(
    parseActiveCommunicationCommand('активное общение 100'),
    { matched: true, action: 'enable', interval: 100 },
);
assert.deepEqual(
    parseActiveCommunicationCommand('активное общение 10 сообщений'),
    { matched: true, action: 'enable', interval: 10 },
);
assert.deepEqual(
    parseActiveCommunicationCommand('активное общение отключить'),
    { matched: true, action: 'disable' },
);
assert.deepEqual(
    parseActiveCommunicationCommand('активное общение откл'),
    { matched: true, action: 'disable' },
);
assert.deepEqual(
    parseActiveCommunicationCommand('статус активного общения'),
    { matched: true, action: 'status' },
);
assert.equal(parseActiveCommunicationCommand('активный человек').matched, false);

const finiteActiveCommunicationLadder = [
    'default',
    'gpt54',
    'gpt55',
    'pro',
    'pro2',
    'pro3',
];
assert.deepEqual(
    buildActiveCommunicationModelModeChain('pro'),
    finiteActiveCommunicationLadder,
);
assert.deepEqual(
    buildActiveCommunicationModelModeChain('pro2'),
    finiteActiveCommunicationLadder,
);
assert.deepEqual(
    buildActiveCommunicationModelModeChain('unknown'),
    finiteActiveCommunicationLadder,
);

assert.equal(isEligibleActiveCommunicationMessage('Пошли пивка попьём'), true);
assert.equal(isEligibleActiveCommunicationMessage('https://example.com'), false);
assert.equal(isEligibleActiveCommunicationMessage('😀😀'), false);
assert.equal(isEligibleActiveCommunicationMessage('/help'), false);

let count = 0;
let target = 10;
for (let index = 1; index <= 9; index += 1) {
    const result = consumeActiveCommunicationCounterValue(count, 10, target, () => 0.9);
    assert.equal(result.shouldReply, false);
    count = result.nextCount;
    target = result.targetOffset;
}
const tenth = consumeActiveCommunicationCounterValue(count, 10, target, () => 0);
assert.equal(tenth.shouldReply, true);
assert.equal(tenth.nextCount, 0);
assert.equal(tenth.targetOffset, 1);

// Early hit must NOT start a new window. For N=10 and target=3 there is
// exactly one reply inside the same ten-message block, then rollover at #10.
let earlyCount = 0;
let earlyTarget = 3;
let earlyReplies = 0;
for (let index = 1; index <= 10; index += 1) {
    const result = consumeActiveCommunicationCounterValue(
        earlyCount,
        10,
        earlyTarget,
        () => 0.4,
    );
    if (result.shouldReply) earlyReplies += 1;
    if (index === 3) {
        assert.equal(result.shouldReply, true);
        assert.equal(result.nextCount, 3);
    }
    if (index === 4) assert.equal(result.shouldReply, false);
    earlyCount = result.nextCount;
    earlyTarget = result.targetOffset;
}
assert.equal(earlyReplies, 1);
assert.equal(earlyCount, 0);
assert.equal(earlyTarget, 5);

assert.equal(chooseActiveCommunicationTargetOffset(100, () => 0), 1);
assert.equal(chooseActiveCommunicationTargetOffset(100, () => 0.9999), 100);
assert.equal(chooseRandomActiveCommunicationPersona(() => 0), 'loshara');
assert.equal(chooseRandomActiveCommunicationPersona(() => 0.9999), 'bydlo');

const prompts = buildActiveCommunicationPrompts({
    currentText: 'Пошли пивка попьём',
    senderName: 'Сева',
    recentTranscript: 'Игорь: дождь идёт',
    communicationStylePrompt: 'Роль: быдло.',
});
assert.match(prompts.systemPrompt, /обычный живой участник/u);
assert.match(prompts.systemPrompt, /отдельную случайную роль/u);
assert.match(prompts.systemPrompt, /Не используй абстрактную бредятину/u);
assert.match(prompts.systemPrompt, /одна короткая естественная реплика/u);
assert.match(prompts.systemPrompt, /Роль: быдло/u);
assert.match(prompts.userPrompt, /Сева/u);

console.log('active communication routing tests passed');

// V188.54: active communication must not time out below observed normal GPT latency.
const appSource = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
assert.match(appSource, /ACTIVE_COMMUNICATION_AI_TIMEOUT_SECONDS/u);
assert.match(appSource, /75_000/u);
