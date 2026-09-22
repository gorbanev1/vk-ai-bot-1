import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    buildProLengthRecoveryInstruction,
    buildProResponseLengthRules,
    enforceResponseLength,
    getResponseLengthProfile,
    isProLengthDeflection,
    isDetailedResponseRequest,
    RESPONSE_LENGTH_PROFILES,
} from '../../src/features/ai/responseLengthRouting.js';

assert.equal(isDetailedResponseRequest('ответь подробно'), true);
assert.equal(isDetailedResponseRequest('объясни подробнее'), true);
assert.equal(isDetailedResponseRequest('максимальный техрасчёт карты'), true);
assert.equal(isDetailedResponseRequest('сделай глубокий разбор'), true);
assert.equal(isDetailedResponseRequest('обычный ответ'), false);

assert.equal(getResponseLengthProfile('обычный ответ').name, 'standard');
assert.equal(getResponseLengthProfile('расскажи подробно').name, 'detailed');
assert.equal(getResponseLengthProfile('прашна', { prashna: true }).name, 'prashna');
assert.equal(getResponseLengthProfile('прашна подробно', { prashna: true }).name, 'prashna-detailed');
assert.equal(getResponseLengthProfile('прашна', { prashna: true, mode: 'pro3' }).name, 'prashna-pro');
assert.equal(getResponseLengthProfile('натал', { natal: true, mode: 'default' }).name, 'natal');
assert.equal(getResponseLengthProfile('натал', { natal: true, mode: 'pro3' }).name, 'natal');
assert.equal(getResponseLengthProfile('обычный вопрос', { mode: 'pro' }).name, 'pro');
assert.equal(getResponseLengthProfile('кто такой X?', { concise: true, mode: 'pro3' }).name, 'pro');
assert.equal(getResponseLengthProfile('кто такой X?', { concise: true, mode: 'default' }).name, 'concise');
assert.equal(RESPONSE_LENGTH_PROFILES.pro.maxCharacters, 14000);
assert.equal(RESPONSE_LENGTH_PROFILES.pro.maxCompletionTokens, 10000);

const proRules = buildProResponseLengthRules('ВКонтакте');
assert.ok(proRules.some((rule) => /до двух больших страниц/iu.test(rule)));
assert.ok(proRules.some((rule) => /не действует обычное правило 8–10 предложений/iu.test(rule)));
assert.ok(proRules.some((rule) => /10 000 слов/iu.test(rule)));
assert.ok(proRules.some((rule) => /не спорь/iu.test(rule)));

assert.equal(
    isProLengthDeflection(
        'Тут эссе на 10 000 слов не влезает. Я не буду делать восемь страниц, могу предложить другой формат.',
    ),
    true,
);
assert.equal(
    isProLengthDeflection(
        'Ответ занимает две страницы, потому что вопрос требует подробного разбора. Далее идёт сам содержательный анализ без отказа.',
    ),
    false,
);
assert.equal(
    isProLengthDeflection(
        `${'Содержательный текст. '.repeat(250)} В одном месте упомянут лимит страницы.`,
    ),
    false,
);
assert.match(
    buildProLengthRecoveryInstruction('Telegram'),
    /сразу выполни исходный запрос/iu,
);

const applicationSource = readFileSync(
    new URL('../../src/app/botApplication.js', import.meta.url),
    'utf8',
);
assert.match(applicationSource, /buildProResponseLengthRules\(platformLabel\)/u);
assert.match(applicationSource, /isProLengthDeflection\(answer\)/u);
assert.match(applicationSource, /GPT PRO LENGTH DEFLECTION/u);

const manyParagraphs = [
    'Первый абзац.',
    'Второй абзац.',
    'Третий абзац.',
    'Четвёртый абзац.',
].join('\n\n');

const standard = enforceResponseLength(manyParagraphs, RESPONSE_LENGTH_PROFILES.standard);
assert.equal(standard.split(/\n\s*\n/u).length, 2);
assert.match(standard, /Четвёртый абзац\.$/u);

const detailed = enforceResponseLength(
    Array.from({ length: 8 }, (_, index) => `Абзац ${index + 1}.`).join('\n\n'),
    RESPONSE_LENGTH_PROFILES.detailed,
);
assert.equal(detailed.split(/\n\s*\n/u).length, 5);

const pro = enforceResponseLength(
    Array.from({ length: 20 }, (_, index) => `Абзац ${index + 1}.`).join('\n\n'),
    RESPONSE_LENGTH_PROFILES.pro,
);
assert.equal(pro.split(/\n\s*\n/u).length, 16);
assert.ok(pro.length <= RESPONSE_LENGTH_PROFILES.pro.maxCharacters + 1);

const natal = enforceResponseLength(
    Array.from({ length: 20 }, (_, index) => `Натальный абзац ${index + 1}.`).join('\n\n'),
    RESPONSE_LENGTH_PROFILES.natal,
);
assert.equal(natal.split(/\n\s*\n/u).length, 16);
assert.ok(natal.length <= RESPONSE_LENGTH_PROFILES.natal.maxCharacters + 1);


const detailedPrashna = enforceResponseLength(
    Array.from({ length: 20 }, (_, index) => `Прашна абзац ${index + 1}.`).join('\n\n'),
    RESPONSE_LENGTH_PROFILES.prashnaDetailed,
);
assert.equal(detailedPrashna.split(/\n\s*\n/u).length, 14);
assert.ok(detailedPrashna.length <= RESPONSE_LENGTH_PROFILES.prashnaDetailed.maxCharacters + 1);

const proPrashna = enforceResponseLength(
    Array.from({ length: 22 }, (_, index) => `Pro прашна абзац ${index + 1}.`).join('\n\n'),
    RESPONSE_LENGTH_PROFILES.prashnaPro,
);
assert.equal(proPrashna.split(/\n\s*\n/u).length, 16);
assert.ok(proPrashna.length <= RESPONSE_LENGTH_PROFILES.prashnaPro.maxCharacters + 1);

const oversized = enforceResponseLength(
    `${'Предложение. '.repeat(500)}Финал.`,
    RESPONSE_LENGTH_PROFILES.standard,
);
assert.ok(oversized.length <= RESPONSE_LENGTH_PROFILES.standard.maxCharacters + 1);
assert.match(oversized, /[.!?…]$/u);

console.log('responseLengthRouting tests: OK');
