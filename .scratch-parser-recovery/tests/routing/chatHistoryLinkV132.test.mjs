import assert from 'node:assert/strict';

import {
    parseChatHistoryLinkCommand,
} from '../../src/features/history/chatHistoryLinkRouting.js';
import {
    isExplicitTelegramNonImageCommand,
} from '../../src/platforms/telegram/telegramBot.js';

assert.deepEqual(
    parseChatHistoryLinkCommand('Гигорейв привязать историю'),
    { matched: true, sourcePeerId: null },
);
assert.deepEqual(
    parseChatHistoryLinkCommand('гигорейв перенести историю беседы peer:2000000123'),
    { matched: true, sourcePeerId: 2000000123 },
);
assert.deepEqual(
    parseChatHistoryLinkCommand('гигорейв подцепить историю'),
    { matched: true, sourcePeerId: null },
);
assert.deepEqual(
    parseChatHistoryLinkCommand('Gigorave восстановить старую беседу peer -3000000123'),
    { matched: true, sourcePeerId: -3000000123 },
);
assert.equal(parseChatHistoryLinkCommand('гигорейв тусы').matched, false);
assert.equal(isExplicitTelegramNonImageCommand('Гигорейв привязать историю'), true);
assert.equal(isExplicitTelegramNonImageCommand('привязать историю'), true);
assert.equal(isExplicitTelegramNonImageCommand('подцепить историю'), true);

console.log('chat history link routing V132: OK');
