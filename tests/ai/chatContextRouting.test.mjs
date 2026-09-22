import assert from 'node:assert/strict';

import {
    classifyChatContextRequest,
    containsCurrentChatReference,
    isChatIllustrationRequest,
} from '../../src/features/ai/chatContextRouting.js';

const chatReferences = [
    'что обсуждали в чате',
    'кто самый активный в чатике',
    'проанализируй всю конфу',
    'что писали в конфочке',
    'что было в кф вчера',
    'что происходило в гч',
    'сделай вывод по беседе',
    'по нашей беседке кто прав',
    'по нашей переписке кто прав',
    'что характерно для общения здесь',
    'summarize this group chat',
    'analyze the convo',
    'что писали в этой конференции',
    'проанализируй сообщения группы',
];

for (const value of chatReferences) {
    assert.equal(
        containsCurrentChatReference(value),
        true,
        value,
    );
}

for (const value of [
    'нарисуй нашу конфу',
    'проиллюстрируй общение в чате',
    'сделай картинку по мотивам беседы',
    'создай постер по нашей переписке',
    'отрисуй атмосферу кф',
]) {
    const result = classifyChatContextRequest(value);
    assert.equal(result.usesChatDatabase, true, value);
    assert.equal(result.wantsImage, true, value);
}

for (const value of [
    'что за картинка была в чате',
    'кто прислал изображение в конфу',
]) {
    assert.equal(isChatIllustrationRequest(value), false, value);
}

for (const value of [
    'нарисуй кота',
    'что такое чат-бот',
    'поговорим о конференции разработчиков',
    'какая группа крови самая редкая',
    'комната выглядит пустой',
]) {
    const result = classifyChatContextRequest(value);
    assert.equal(result.usesChatDatabase, false, value);
}

console.log('chatContextRouting tests: OK');
