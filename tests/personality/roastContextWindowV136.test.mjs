import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ROAST_CONTEXT_MAX_MESSAGES,
    ROAST_CONTEXT_MIN_MESSAGES,
    buildRoastPrompts,
    selectRoastContextMessages,
} from '../../src/features/personality/roastCommandRouting.js';

const NOW = 2_000_000_000;

function makeMessage(index, {
    ageSeconds = index * 60,
    text = `сообщение ${index}`,
} = {}) {
    return {
        createdAt: NOW - ageSeconds,
        text,
    };
}

test('roast context uses at least 20 messages when history has them', () => {
    const messages = Array.from({ length: 25 }, (_, index) => makeMessage(index + 1, {
        ageSeconds: (index + 1) * 2 * 24 * 60 * 60,
    }));

    const selected = selectRoastContextMessages(messages, { now: NOW });

    assert.ok(selected.length >= ROAST_CONTEXT_MIN_MESSAGES);
    assert.ok(selected.length <= ROAST_CONTEXT_MAX_MESSAGES);
});

test('roast context never exceeds 60 messages', () => {
    const messages = Array.from({ length: 100 }, (_, index) => makeMessage(index + 1, {
        ageSeconds: index * 30,
        text: `коротко ${index + 1}`,
    }));

    const selected = selectRoastContextMessages(messages, { now: NOW });

    assert.equal(selected.length, ROAST_CONTEXT_MAX_MESSAGES);
});

test('quiet 24h window backfills older history to reach 20 messages', () => {
    const oldMessages = Array.from({ length: 18 }, (_, index) => makeMessage(index + 1, {
        ageSeconds: 2 * 24 * 60 * 60 + index * 60,
        text: `старое ${index + 1}`,
    }));
    const recentMessages = Array.from({ length: 5 }, (_, index) => makeMessage(index + 100, {
        ageSeconds: index * 60,
        text: `свежее ${index + 1}`,
    }));

    const selected = selectRoastContextMessages(
        [...oldMessages, ...recentMessages],
        { now: NOW },
    );

    assert.ok(selected.length >= 20);
    assert.ok(selected.some((message) => message.text.startsWith('старое')));
    assert.ok(selected.some((message) => message.text.startsWith('свежее')));
});

test('token budget is adaptive after minimum 20 messages', () => {
    const messages = Array.from({ length: 60 }, (_, index) => makeMessage(index + 1, {
        ageSeconds: index * 30,
        text: `длинное ${index + 1} ${'x'.repeat(500)}`,
    }));

    const selected = selectRoastContextMessages(messages, { now: NOW });

    assert.ok(selected.length >= ROAST_CONTEXT_MIN_MESSAGES);
    assert.ok(selected.length < ROAST_CONTEXT_MAX_MESSAGES);
});

test('roast commands themselves are not fed back into roast context', () => {
    const messages = [
        ...Array.from({ length: 20 }, (_, index) => makeMessage(index + 1)),
        makeMessage(100, { text: 'доебись Денни', ageSeconds: 5 }),
    ];

    const selected = selectRoastContextMessages(messages, { now: NOW });

    assert.ok(selected.length >= 20);
    assert.ok(selected.every((message) => !message.text.startsWith('доебись')));
});

test('roast prompt is compact and explicitly grounded in target messages', () => {
    const prompts = buildRoastPrompts({
        persona: 'bydlo',
        targetName: 'Денни',
        transcript: '1. тестовая реплика',
    });

    assert.match(prompts.systemPrompt, /Режим «ДОЕБИСЬ»/u);
    assert.match(prompts.systemPrompt, /Мат разрешён/u);
    assert.match(prompts.systemPrompt, /Не выдумывай факты/u);
    assert.match(prompts.userPrompt, /Цель: Денни/u);
    assert.match(prompts.userPrompt, /1\. тестовая реплика/u);
    assert.ok(prompts.systemPrompt.length < 1200);
});
