import assert from 'node:assert/strict';

import {
    extractExplicitGptMode,
    getPrashnaPayloadProfile,
    resolvePrashnaGptMode,
} from '../../src/features/ai/gptModeRouting.js';

const cases = [
    ['pro3 прашна Москва вопрос', 'pro3', 'прашна Москва вопрос'],
    ['gpt pro3 прашна нравится ли чату мой ии бот?', 'pro3', 'gpt прашна нравится ли чату мой ии бот?'],
    ['джйотиш прашна pro3 Тимасин сегодня?', 'pro3', 'джйотиш прашна Тимасин сегодня?'],
    ['прашна нравится ли чату мой ии бот pro3', 'pro3', 'прашна нравится ли чату мой ии бот'],
    ['прашна, pro3: нравится ли чату мой ии бот?', 'pro3', 'прашна, нравится ли чату мой ии бот?'],
    ['джйотиш прашна sol Москва вопрос', 'pro3', 'джйотиш прашна Москва вопрос'],
    ['прашна терра Москва вопрос', 'pro2', 'прашна Москва вопрос'],
    ['прашна pro вопрос', 'pro', 'прашна вопрос'],
    ['gpt55 подробно объясни', 'gpt55', 'подробно объясни'],
    ['классик расскажи', 'gpt55', 'расскажи'],
    ['gpt54 расскажи', 'gpt54', 'расскажи'],
    ['стандарт резюмируй', 'gpt54', 'резюмируй'],
    ['mini обычный вопрос', 'default', 'обычный вопрос'],
    ['база нарисуй кота', 'default', 'нарисуй кота'],
    ['самая дешевая модель ответь', 'default', 'ответь'],
    ['обычный вопрос', 'default', 'обычный вопрос'],
    ['profile пользователя', 'default', 'profile пользователя'],
    ['pro30 вопрос', 'default', 'pro30 вопрос'],
    ['pro вопрос mini', 'pro', 'вопрос mini'],
    ['pro3 вопрос gpt55', 'pro3', 'вопрос gpt55'],
];

for (const [input, expectedMode, expectedBody] of cases) {
    const parsed = extractExplicitGptMode(input);
    assert.equal(parsed.mode, expectedMode, input);
    assert.equal(parsed.body, expectedBody, input);
}

for (const mode of ['default', 'gpt54', 'gpt55', 'pro', 'pro2', 'pro3']) {
    assert.equal(resolvePrashnaGptMode(mode), mode);
    assert.notEqual(getPrashnaPayloadProfile(mode), 'fast');
}

for (const mode of ['default', 'gpt54', 'gpt55']) {
    assert.equal(getPrashnaPayloadProfile(mode), 'maximum');
}

for (const mode of ['pro', 'pro2', 'pro3']) {
    assert.equal(getPrashnaPayloadProfile(mode), 'none');
    assert.equal(
        getPrashnaPayloadProfile(mode, { localCalculation: true }),
        'maximum',
    );
}

console.log('gptModeRouting tests: OK');
