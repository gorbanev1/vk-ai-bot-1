import assert from 'node:assert/strict';

import {
    buildVisionTaskDescriptor,
    getVisionModeChain,
    isImageInspectionRequest,
    resolveVisionMode,
} from '../../src/features/ai/visionRouting.js';


assert.equal(resolveVisionMode('vision-default'), 'default');
assert.equal(resolveVisionMode(''), 'default');
assert.equal(resolveVisionMode('luna'), 'default');
assert.equal(resolveVisionMode('pro3'), 'pro3');
assert.deepEqual(getVisionModeChain('vision-default'), [
    'default', 'pro3', 'astra',
]);
assert.deepEqual(getVisionModeChain('pro2'), ['pro3', 'astra']);

assert.equal(isImageInspectionRequest('что на картинке?'), true);
assert.equal(isImageInspectionRequest('Гигорейв, что изображено'), true);
assert.equal(isImageInspectionRequest('проанализируй фото коротко'), true);
assert.equal(isImageInspectionRequest('предложи варианты'), true);
assert.equal(isImageInspectionRequest('предложи варианты маршрута'), true);
assert.equal(isImageInspectionRequest('нарисуй картинку'), false);
assert.equal(isImageInspectionRequest('расскажи анекдот'), false);

const explicit = buildVisionTaskDescriptor('Что на картинке, коротко?');
assert.equal(explicit.matched, true);
assert.equal(explicit.explicitImageLanguage, true);
assert.equal(explicit.requiresExistingImage, false);
assert.equal(explicit.wantsShortAnswer, true);

const variants = buildVisionTaskDescriptor('Предложи варианты');
assert.equal(variants.matched, true);
assert.equal(variants.explicitImageLanguage, false);
assert.equal(variants.requiresExistingImage, true);
assert.equal(variants.wantsVariants, true);

console.log('visionRouting tests: OK');
