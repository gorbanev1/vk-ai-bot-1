import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    parseAutoSummaryCommand,
    getNextAutoSummaryRunAt,
    resolveAutoSummaryRunWindow,
} from '../../src/features/ai/autoSummaryRouting.js';

const timeZone = 'Europe/Moscow';
const ts = (iso) => Math.floor(new Date(iso).getTime() / 1000);

test('авторезюме/резюмирование commands are deterministic local commands', () => {
    assert.deepEqual(parseAutoSummaryCommand('авторезюме'), {
        matched: true,
        action: 'enable',
        mode: 'full',
    });
    assert.equal(parseAutoSummaryCommand('резюмирование вкл').action, 'enable');
    assert.equal(parseAutoSummaryCommand('Гигорейв авторезюме').mode, 'full');
    assert.equal(parseAutoSummaryCommand('авторезюме только день').mode, 'day');
    assert.equal(parseAutoSummaryCommand('авторезюме только вечер').mode, 'evening');
    assert.equal(parseAutoSummaryCommand('резюмирование выкл').action, 'disable');
    assert.equal(parseAutoSummaryCommand('резюмирование статус').action, 'status');
    assert.equal(parseAutoSummaryCommand('что такое авторезюме').matched, false);
});

test('plain резюмирование enabled at noon waits until fixed 13:00 slot', () => {
    const after = ts('2026-08-28T09:00:00Z'); // 12:00 MSK
    const next = getNextAutoSummaryRunAt({
        mode: 'full',
        afterTimestamp: after,
        timeZone,
    });
    assert.equal(next, ts('2026-08-28T10:00:00Z')); // 13:00 MSK
});

test('every legacy mode is coerced to the same fixed schedule', () => {
    assert.equal(
        getNextAutoSummaryRunAt({
            mode: 'full',
            afterTimestamp: ts('2026-08-28T10:00:00Z'), // 13:00 MSK
            timeZone,
        }),
        ts('2026-08-28T12:00:00Z'), // 15:00 MSK
    );
    assert.equal(
        getNextAutoSummaryRunAt({
            mode: 'evening',
            schedule: ['17:17'], // ignored legacy custom schedule
            afterTimestamp: ts('2026-08-28T14:00:00Z'), // 17:00 MSK
            timeZone,
        }),
        ts('2026-08-28T15:00:00Z'), // 18:00 MSK
    );
});

test('fixed 13:00 slot owns exactly the 09:00→13:00 interval', () => {
    const scheduled = ts('2026-08-28T10:00:00Z'); // 13:00 MSK
    const window = resolveAutoSummaryRunWindow({
        mode: 'day', // legacy mode cannot change boundaries anymore
        scheduledTimestamp: scheduled,
        timeZone,
    });
    assert.equal(window.summaryDate, '2026-08-28');
    assert.equal(window.slotLabel, '13:00');
    assert.equal(window.startTimestamp, ts('2026-08-28T06:00:00Z')); // 09:00 MSK
    assert.equal(window.endTimestamp, scheduled);
});

test('first 09:00 slot starts at local midnight', () => {
    const scheduled = ts('2026-08-28T06:00:00Z'); // 09:00 MSK
    const window = resolveAutoSummaryRunWindow({
        mode: 'full',
        scheduledTimestamp: scheduled,
        timeZone,
    });
    assert.equal(window.startTimestamp, ts('2026-08-27T21:00:00Z')); // 00:00 MSK
    assert.equal(window.endTimestamp, scheduled);
});

test('runtime intercepts autoresume and durable calendar pipeline owns scheduling', () => {
    const source = readFileSync(
        new URL('../../src/app/botApplication.js', import.meta.url),
        'utf8',
    );
    assert.match(source, /parseIncomingCommand\(\s*text,\s*parseAutoSummaryCommand/su);
    assert.match(source, /parseIncomingCommand\(\s*originalText,\s*parseAutoSummaryCommand/su);
    assert.match(source, /LEGACY_AUTO_SUMMARY_SCHEDULER_ENABLED/u);
    assert.match(source, /calendar rollup owns scheduled summaries/u);
    assert.match(source, /Настройка сохранена в SQLite и переживает перезапуск/u);
    assert.match(source, /slices=09:00,13:00,15:00,18:00,21:00,23:59/u);
    assert.doesNotMatch(source, /с 06:00/u);
});
