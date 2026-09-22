import assert from 'node:assert/strict';

import {
    appendUnknownTermGrounding,
    buildUnknownTermGroundingBlock,
    filterUnknownTermsForMemory,
    parseUnknownTermsResponse,
} from '../../src/features/ai/unknownTermRouting.js';

assert.deepEqual(
    parseUnknownTermsResponse('```json\n{"terms":["цыжмюк","бакрыжька","цыжмюк"]}\n```'),
    ['цыжмюк', 'бакрыжька'],
);

assert.deepEqual(
    parseUnknownTermsResponse('{"unknown_terms":[]}'),
    [],
);

assert.deepEqual(
    filterUnknownTermsForMemory([
        'джйотиш',
        'натал',
        'натальная карта',
        'цыжмюк',
    ]),
    ['цыжмюк'],
);

assert.deepEqual(
    parseUnknownTermsResponse('- цыжмюк\n- Котёл Куража'),
    ['цыжмюк', 'Котёл Куража'],
);

const block = buildUnknownTermGroundingBlock({
    terms: ['цыжмюк', 'бакрыжька'],
    definitions: [
        {
            term: 'цыжмюк',
            contextText: 'Цыжмюк — выдуманное блюдо конфы.',
        },
    ],
    unresolvedTerms: ['бакрыжька'],
});

assert.match(block, /Цыжмюк — выдуманное блюдо/iu);
assert.match(block, /бакрыжька/iu);
assert.match(
    appendUnknownTermGrounding('Напиши рецепт цыжмюка', block),
    /ИСХОДНЫЙ ЗАПРОС/iu,
);

console.log('unknownTermRouting tests: OK');
