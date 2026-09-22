import assert from 'node:assert/strict';

import {
    createBotMentionTools,
    isHelpCommand,
    isVersionCommand,
    normalizeLocalCommand,
} from '../../src/shared/commands.js';

assert.equal(normalizeLocalCommand('/ПОМОЩЬ?!'), 'помощь');
assert.equal(isHelpCommand('что ты умеешь'), true);
assert.equal(isVersionCommand('сборка бота'), true);

let telegramUsername = 'Gigorave_bot';
const tools = createBotMentionTools({
    groupId: '233007447',
    getTelegramBotUsername: () => telegramUsername,
});

assert.equal(tools.containsBotMention('Гигорейв привет'), true);
assert.equal(tools.containsBotMention('Гигарейф, ты лох'), true);
assert.equal(tools.removeBotMentions('Гигарейф, теперь ты лох'), 'теперь ты лох');
assert.equal(tools.containsBotMention('@Gigorave_bot привет'), true);
assert.equal(tools.removeBotMentions('@Gigorave_bot, привет!'), 'привет');
assert.equal(
    tools.removeBotMentions('[club233007447|Гигорейв] — тест'),
    'тест',
);

telegramUsername = '';
assert.equal(tools.containsBotMention('@Gigorave_bot привет'), false);

const dualVkTools = createBotMentionTools({
    groupId: '233007447',
    groupIds: ['240709021'],
    getTelegramBotUsername: () => '',
});
assert.equal(
    dualVkTools.containsBotMention('[club240709021|Случайное Пересоздание] корды'),
    true,
);
assert.equal(
    dualVkTools.removeBotMentions('[club240709021|Случайное Пересоздание] корды'),
    'корды',
);

console.log('sharedCommands tests: OK');
