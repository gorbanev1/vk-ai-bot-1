import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';


import {
    OUTBURST_SCENARIO_WEIGHTS,
    buildCommunicationStyleInstruction,
    buildModelOutburstPrompts,
    buildRandomOutburst,
    formatCommunicationStyleStatus,
    isOutburstPersona,
    parseCommunicationStyleCommand,
    selectActiveBehaviorModelMode,
    selectOutburstScenario,
} from '../../src/features/personality/communicationStyleRouting.js';

assert.deepEqual(
    parseCommunicationStyleCommand('температура общения 9 из 10'),
    {
        matched: true,
        action: 'set',
        warmth: 9,
        persona: null,
    },
);

assert.deepEqual(
    parseCommunicationStyleCommand('поставь температуру общений на 1/10'),
    {
        matched: true,
        action: 'set',
        warmth: 1,
        persona: null,
    },
);

assert.equal(
    parseCommunicationStyleCommand('будь быдлом').persona,
    'bydlo',
);
assert.equal(
    parseCommunicationStyleCommand('будь хамом').persona,
    'ham',
);
assert.equal(
    parseCommunicationStyleCommand('будь лошарой').persona,
    'loshara',
);
assert.equal(
    parseCommunicationStyleCommand('будь дурачиной').persona,
    'durachila',
);
assert.equal(
    parseCommunicationStyleCommand('будь интеллигентом').persona,
    'intelligent',
);
assert.equal(
    parseCommunicationStyleCommand('будь учёным').persona,
    'scientist',
);
assert.equal(
    parseCommunicationStyleCommand('будь политиком').persona,
    'politician',
);

assert.deepEqual(
    parseCommunicationStyleCommand('сбрось стиль'),
    {
        matched: true,
        action: 'reset',
        warmth: 5,
        persona: 'neutral',
    },
);

assert.equal(
    parseCommunicationStyleCommand('стиль общения').action,
    'status',
);
assert.equal(
    parseCommunicationStyleCommand('нарисуй хамом машину').matched,
    false,
);
assert.equal(
    parseCommunicationStyleCommand('что значит фраза будь хамом').matched,
    false,
);
assert.equal(isOutburstPersona('bydlo'), true);
assert.equal(isOutburstPersona('durachila'), true);
assert.equal(isOutburstPersona('ham'), false);

const scientistPrompt = buildCommunicationStyleInstruction({
    warmth: 9,
    persona: 'scientist',
});
assert.match(scientistPrompt, /9\/10/u);
assert.match(scientistPrompt, /учёный-исследователь/u);

const bydloPrompt = buildCommunicationStyleInstruction({
    warmth: 2,
    persona: 'bydlo',
});
assert.match(bydloPrompt, /холодным язвительным цинизмом/u);
assert.match(bydloPrompt, /Не используй мягкие клоунские образы/u);

const durachilaPrompt = buildCommunicationStyleInstruction({
    warmth: 5,
    persona: 'durachila',
});
assert.match(durachilaPrompt, /откровенно тупой/u);
assert.match(durachilaPrompt, /никаких говорящих холодильников/u);

const status = formatCommunicationStyleStatus({
    warmth: 3,
    persona: 'bydlo',
    isGroup: true,
    activeChatEnabled: true,
});
assert.match(status, /3\/10/u);
assert.match(status, /1 случайный ответ на окно из 10 сообщений/u);
assert.match(status, /роль каждого автоответа выбирается заново/u);
assert.match(status, /фоновые выкрики: выключены/u);

const disabledStatus = formatCommunicationStyleStatus({
    warmth: 3,
    persona: 'bydlo',
    isGroup: true,
    activeChatEnabled: false,
});
assert.match(disabledStatus, /активное общение: выключено/u);
assert.match(disabledStatus, /фоновые выкрики: выключены/u);

assert.deepEqual(OUTBURST_SCENARIO_WEIGHTS, {
    conversation: 0.4,
    air: 0.4,
    participant: 0.2,
});
assert.equal(selectOutburstScenario(() => 0), 'conversation');
assert.equal(selectOutburstScenario(() => 0.399999), 'conversation');
assert.equal(selectOutburstScenario(() => 0.4), 'air');
assert.equal(selectOutburstScenario(() => 0.799999), 'air');
assert.equal(selectOutburstScenario(() => 0.8), 'participant');
assert.equal(selectOutburstScenario(() => 0.999999), 'participant');

assert.equal(selectActiveBehaviorModelMode(() => 0), 'pro');
assert.equal(selectActiveBehaviorModelMode(() => 0.499999), 'pro');
assert.equal(selectActiveBehaviorModelMode(() => 0.5), 'pro2');
assert.equal(selectActiveBehaviorModelMode(() => 0.999999), 'pro2');

const participantOutburst = buildRandomOutburst({
    persona: 'durachila',
    scenario: 'participant',
    targetName: 'Игорь',
    random: () => 0,
});
assert.match(participantOutburst, /^Игорь,/u);
assert.doesNotMatch(participantOutburst, /кабач|холодильник|носок/u);

const airOutburst = buildRandomOutburst({
    persona: 'bydlo',
    scenario: 'air',
    targetName: 'Игорь',
    random: () => 0,
});
assert.doesNotMatch(airOutburst, /Игорь/u);

const conversationPrompts = buildModelOutburstPrompts({
    persona: 'bydlo',
    scenario: 'conversation',
    recentTranscript: 'Сева: Я точно прав\nИгорь: Ты ничего не проверил',
});
assert.match(conversationPrompts.systemPrompt, /холодно-циничной/u);
assert.match(conversationPrompts.systemPrompt, /относится ко всей текущей беседе/u);
assert.match(conversationPrompts.userPrompt, /Я точно прав/u);

const durachilaOutburstPrompts = buildModelOutburstPrompts({
    persona: 'durachila',
    scenario: 'air',
});
assert.match(durachilaOutburstPrompts.systemPrompt, /откровенно тупой/u);
assert.match(durachilaOutburstPrompts.systemPrompt, /Не пиши сюрреализм/u);


const applicationSource = readFileSync(
    new URL('../../src/app/botApplication.js', import.meta.url),
    'utf8',
);
assert.match(applicationSource, /COMMUNICATION_OUTBURST_MIN_SECONDS = 60;/u);
assert.match(applicationSource, /COMMUNICATION_OUTBURST_MAX_SECONDS = 60 \* 60;/u);
assert.match(applicationSource, /scenario = selectOutburstScenario\(\)/u);
assert.match(applicationSource, /generateActiveBehaviorGptText/u);
assert.match(applicationSource, /scenario === 'participant' && target/u);
assert.match(applicationSource, /buildOutburstConversationTranscript/u);

console.log('communicationStyleRouting tests: OK');
