import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

function loadParseSummaryRange() {
    const start = source.indexOf('const SUMMARY_USAGE_HINT = [');
    const end = source.indexOf('/*\n * Команды GPT через OpenAI-совместимый router.cheap.', start);
    assert.ok(start >= 0 && end > start, 'parseSummaryRange source block must exist');
    const block = source.slice(start, end);
    return Function(`const MAX_MESSAGES = 20000;\n${block}\nreturn parseSummaryRange;`)();
}

test('V188 plain "резюмируй за день" means operational day instead of default 100 messages', () => {
    const parseSummaryRange = loadParseSummaryRange();
    assert.deepEqual(parseSummaryRange('резюмируй за день'), {
        ok: true,
        range: { unit: 'operational-day', value: 1 },
    });
    assert.deepEqual(parseSummaryRange('резюмируй сегодня'), {
        ok: true,
        range: { unit: 'operational-day', value: 1 },
    });
});

test('V188 natural singular week/day-duration forms do not fall back to 100 messages', () => {
    const parseSummaryRange = loadParseSummaryRange();
    assert.deepEqual(parseSummaryRange('резюмируй за сутки'), {
        ok: true,
        range: { unit: 'days', value: 1 },
    });
    assert.deepEqual(parseSummaryRange('резюмируй за неделю'), {
        ok: true,
        range: { unit: 'weeks', value: 1 },
    });
});

test('V188 numeric day ranges retain rolling-duration semantics', () => {
    const parseSummaryRange = loadParseSummaryRange();
    assert.deepEqual(parseSummaryRange('резюмируй за 1 день'), {
        ok: true,
        range: { unit: 'days', value: 1 },
    });
    assert.deepEqual(parseSummaryRange('резюмируй 2 дня'), {
        ok: true,
        range: { unit: 'days', value: 2 },
    });
});

test('V188 operational summary day starts at 06:00 Europe/Moscow and has no 100-message fallback cap', () => {
    const start = source.indexOf('function getOperationalSummaryDayWindow(now = new Date()) {');
    const end = source.indexOf('function loadRange(peerId, range) {', start);
    const body = source.slice(start, end);
    assert.match(body, /localClockMinutes\(now\) < 6 \* 60/u);
    assert.match(body, /zonedDateTimeToUtcMilliseconds\(startDate, 6, 0, botTimeZone\)/u);

    const loadStart = source.indexOf("if (range.unit === 'operational-day') {");
    const loadEnd = source.indexOf('\n\n    const seconds = {', loadStart);
    const loadBody = source.slice(loadStart, loadEnd);
    assert.match(loadBody, /createdAt >= window\.startAt && createdAt <= window\.endAt/u);
    assert.doesNotMatch(loadBody, /slice\(-?100\)|value:\s*100/u);
});
