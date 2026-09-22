import assert from 'node:assert/strict';

import {
    getProInferenceControls,
    isProResponseMode,
} from '../../src/features/ai/proInferencePolicy.js';

for (const mode of ['pro', 'pro2', 'pro3']) {
    assert.equal(isProResponseMode(mode), true);
    assert.deepEqual(getProInferenceControls(mode), {
        reasoningEffort: 'high',
        verbosity: 'high',
    });
}

for (const mode of ['default', 'gpt54', 'gpt55', '', null]) {
    assert.equal(isProResponseMode(mode), false);
    assert.deepEqual(getProInferenceControls(mode), {});
}

console.log('proInferencePolicy tests: OK');
