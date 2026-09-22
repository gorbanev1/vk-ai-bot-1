import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    GIGORAVE_IDENTITY_MARKER,
    GIGORAVE_IDENTITY_PROMPT,
    withGigoraveIdentity,
    withGigoraveIdentityUserPrompt,
} from '../../src/features/ai/gigoraveIdentity.js';

test('V188.44 identity invariant explicitly says the model is bot Gigorave', () => {
    assert.match(GIGORAVE_IDENTITY_PROMPT, /Ты — бот Гигорейв \(Gigorave\)/u);
    assert.match(GIGORAVE_IDENTITY_PROMPT, /по умолчанию относятся к тебе/u);
    assert.match(GIGORAVE_IDENTITY_PROMPT, /не спрашивай «что такое Гигорейв\?»/u);
});

test('V188.44 identity wrapper is idempotent and does not multiply prompt tokens on retries', () => {
    const once = withGigoraveIdentity('Сделай краткое резюме сообщений.');
    const twice = withGigoraveIdentity(once);

    assert.equal(twice, once);
    assert.equal(once.split(GIGORAVE_IDENTITY_MARKER).length - 1, 1);
});

test('V188.44 summary/service prompt keeps output format while knowing Gigorave identity', () => {
    const prompt = withGigoraveIdentity('Верни только JSON без пояснений.');

    assert.match(prompt, /бот Гигорейв/u);
    assert.match(prompt, /при резюме, классификации, JSON/u);
    assert.match(prompt, /Верни только JSON без пояснений/u);
});

test('V188.44 explicit external-provider chat receives the same identity invariant', () => {
    const prompt = withGigoraveIdentityUserPrompt('Кто такой Гигорейв?');

    assert.match(prompt, /бот Гигорейв/u);
    assert.match(prompt, /Кто такой Гигорейв\?/u);
});

test('V188.44 central OpenAI text gateway injects identity before every routed text request', () => {
    const source = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const start = source.indexOf('async function generateOpenAIText(options)');
    const end = source.indexOf('\nfunction resolveAuditedTransportPolicy', start);
    const block = source.slice(start, end);

    assert.ok(start >= 0 && end > start);
    assert.match(block, /withGigoraveIdentity\(options\?\.systemPrompt\)/u);
    assert.match(block, /systemPrompt: enrichedSystemPrompt/u);
    assert.match(block, /request: \(credential\) => generateOpenAITextCore/u);
});

test('V188.44 external provider gateway injects identity for Gemini, Anthropic and OpenAI-compatible chats', () => {
    const source = readFileSync(new URL('../../src/features/ai/externalProviderRouting.js', import.meta.url), 'utf8');
    const start = source.indexOf('async function callExternalModel');
    const end = source.indexOf('\n\nfunction imageHealthEligible', start);
    const block = source.slice(start, end);

    assert.match(block, /withGigoraveIdentityUserPrompt\(prompt\)/u);
    assert.equal((block.match(/clean\(identityPrompt\)/gu) || []).length, 3);
});
