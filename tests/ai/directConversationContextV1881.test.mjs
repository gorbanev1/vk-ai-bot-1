import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildDirectConversationContext,
    DIRECT_CONVERSATION_CONTEXT_LIMIT,
} from '../../src/features/ai/directConversationContext.js';
import {
    buildIncomingMessagePromptBlock,
} from '../../src/features/ai/incomingMessagePrompt.js';

test('direct context keeps 40 newest messages and identifies current author by name + id', () => {
    const messages = Array.from({ length: 55 }, (_, index) => ({
        senderId: index % 2 ? 101 : 202,
        text: `message-${index + 1}`,
    }));
    const names = new Map([[101, 'Максим Крылов'], [202, 'Антон Гора']]);
    const result = buildDirectConversationContext({
        platform: 'vk',
        currentSenderId: 101,
        currentSenderName: 'Максим Крылов',
        participantNames: names,
        messages,
    });

    assert.equal(DIRECT_CONVERSATION_CONTEXT_LIMIT, 40);
    assert.equal(result.messageCount, 40);
    assert.match(result.text, /Текущий автор обращения: Максим Крылов \[vk:101\]/u);
    assert.match(result.text, /«я».*Максим Крылов \[vk:101\]/u);
    assert.doesNotMatch(result.text, /message-1\b/u);
    assert.match(result.text, /message-55\b/u);
    assert.match(result.text, /Антон Гора \[vk:202\]:/u);
});

test('incoming message binding explicitly maps first-person pronouns to participant identity', () => {
    const block = buildIncomingMessagePromptBlock({
        platform: 'vk',
        peerIndex: 2000000006,
        messageIndex: 123,
        participantName: 'Максим Крылов',
        participantIndex: 101,
        messageText: 'Почему его ты присвоил, а меня нет?',
    });

    assert.match(block, /participant_name=Максим Крылов/u);
    assert.match(block, /participant_index=101/u);
    assert.match(block, /«я».*«меня».*participant_name/u);
    assert.match(block, /Не спрашивай, кто такой participant_name/u);
});
