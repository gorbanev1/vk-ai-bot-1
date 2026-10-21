import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCommandPriority } from '../../src/features/routing/commandPriorityRouting.js';

test('image command aliases route as explicit GPT image actions', () => {
    // parseGptCommand is intentionally private; exercise the public routing
    // contract for every user-facing spelling.
    for (const command of [
        'нарисуй flare петуха',
        'сгенерируй image2.5 ночной город',
        'изобрази sunburst нашу беседу',
        'image2 нарисуй кота',
        'gpt image-model=image2.5 нарисуй кота',
    ]) {
        assert.equal(resolveCommandPriority(command).route, 'gpt-explicit-action', command);
    }
});
