import assert from 'node:assert/strict';
import test from 'node:test';

import {
    VK_HISTORY_STARTUP_MAX_MESSAGES,
    VK_HISTORY_STARTUP_WINDOW_SECONDS,
    getVkHistoryPullCutoffTimestamp,
    parseVkHistoryPullCommand,
} from '../../src/features/history/vkHistoryPullPolicy.js';

test('V188.23 startup history policy is one day and at most 3500 messages', () => {
    assert.equal(VK_HISTORY_STARTUP_WINDOW_SECONDS, 24 * 60 * 60);
    assert.equal(VK_HISTORY_STARTUP_MAX_MESSAGES, 3500);
});

test('V188.23 parses explicit owner history ranges', () => {
    assert.deepEqual(
        parseVkHistoryPullCommand('Гигорейв подтяни историю 6 часов'),
        {
            matched: true,
            valid: true,
            durationSeconds: 6 * 60 * 60,
            durationLabel: '6 ч.',
            defaulted: false,
        },
    );
    assert.equal(parseVkHistoryPullCommand('подтяни историю 2 дня').durationSeconds, 2 * 24 * 60 * 60);
    assert.equal(parseVkHistoryPullCommand('подтяни историю 1 неделя').durationSeconds, 7 * 24 * 60 * 60);
});

test('V188.23 bare pull command defaults to one day', () => {
    const parsed = parseVkHistoryPullCommand('подтяни историю');
    assert.equal(parsed.matched, true);
    assert.equal(parsed.valid, true);
    assert.equal(parsed.defaulted, true);
    assert.equal(parsed.durationSeconds, 24 * 60 * 60);
});

test('V188.23 rejects an ambiguous history range instead of guessing', () => {
    const parsed = parseVkHistoryPullCommand('подтяни историю давно');
    assert.equal(parsed.matched, true);
    assert.equal(parsed.valid, false);
});

test('V188.23 cutoff is deterministic', () => {
    assert.equal(
        getVkHistoryPullCutoffTimestamp({ nowTimestamp: 2_000_000, durationSeconds: 6 * 60 * 60 }),
        2_000_000 - 6 * 60 * 60,
    );
});

const appSource = await import('node:fs/promises').then(({ readFile }) =>
    readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8')
);

test('V188.23 startup and periodic recovery are explicitly bounded and deep archive auto-crawler is absent', () => {
    assert.match(appSource, /maxMessages: VK_HISTORY_STARTUP_MAX_MESSAGES,[\s\S]*?reason: 'startup'/u);
    assert.match(appSource, /maxMessages: VK_HISTORY_STARTUP_MAX_MESSAGES,[\s\S]*?reason: 'periodic'/u);
    assert.doesNotMatch(appSource, /runVkArchiveRecovery\(/u);
    assert.match(appSource, /reason: 'owner-command'/u);
    assert.match(appSource, /maxMessages: Number\.POSITIVE_INFINITY/u);
});
