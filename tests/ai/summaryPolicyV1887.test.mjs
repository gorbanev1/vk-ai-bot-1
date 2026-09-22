import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

function loadParseSummaryRange() {
    const start = source.indexOf('const SUMMARY_USAGE_HINT = [');
    const end = source.indexOf('/*\n * Команды GPT через OpenAI-совместимый router.cheap.', start);
    assert.ok(start >= 0 && end > start, 'summary parser source block must exist');
    const block = source.slice(start, end);
    return Function(`const MAX_MESSAGES = 20000;\n${block}\nreturn parseSummaryRange;`)();
}

test('V188.7 bare or filler-only summary request returns usage hint, never hidden last-100 fallback', () => {
    const parseSummaryRange = loadParseSummaryRange();
    for (const request of ['резюмируй', 'резюмируй пожалуйста', 'резюмируй это кратко']) {
        const parsed = parseSummaryRange(request);
        assert.equal(parsed.ok, false, request);
        assert.match(parsed.error, /Не понял, что именно нужно резюмировать/u);
        assert.doesNotMatch(parsed.error, /последн(?:ие|их)\s+100/iu);
    }
});

test('V188.7 participant focus defaults to all linked history while explicit ranges remain explicit', () => {
    const parseSummaryRange = loadParseSummaryRange();
    assert.deepEqual(parseSummaryRange('резюмируй Тимасина'), {
        ok: true,
        range: { unit: 'all', value: 0 },
        focusQuery: 'Тимасина',
    });
    assert.deepEqual(parseSummaryRange('резюмируй за день'), {
        ok: true,
        range: { unit: 'operational-day', value: 1 },
    });
    assert.deepEqual(parseSummaryRange('резюмируй всю переписку'), {
        ok: true,
        range: { unit: 'all', value: 0 },
    });
});

test('V188.7 participant summary scans linked history, own messages and ±10 mention context with AI filtering', () => {
    assert.match(source, /function loadLinkedSummaryHistory\(peerId\)/u);
    assert.match(source, /loadVkMessageArchiveMessages|loadLinkedSummaryHistory/u);
    assert.match(source, /analyzeParticipantDatabaseMessages/u);
    assert.match(source, /analyzeParticipantMentionDatabaseMessages/u);
    assert.match(source, /buildParticipantMentionContextWindows\(allMessages, matches, \{ radius: 10 \}\)/u);
    assert.match(source, /Сначала отбрось всё, что не связано/u);
    assert.match(source, /participantSummary = await createFocusedParticipantSummary/u);
    assert.match(source, /range: range \|\| \{ unit: 'all', value: 0 \}/u);
});

test('V188.7 rolling time ranges are not silently truncated to MAX_MESSAGES', () => {
    const start = source.indexOf('function loadRange(peerId, range) {');
    const end = source.indexOf('function filterSummaryMessages(messages) {', start);
    const block = source.slice(start, end);
    const rollingStart = block.indexOf('const seconds = {');
    assert.ok(rollingStart >= 0);
    const rolling = block.slice(rollingStart);
    assert.doesNotMatch(rolling, /slice\(-MAX_MESSAGES\)/u);
});

test('V188.43 calendar rollup fires at local midnight boundaries, not the old 20:00 windows', () => {
    assert.doesNotMatch(source, /HIERARCHICAL_PERIOD_SEND_HOUR = 20/u);
    assert.match(source, /CALENDAR_SUMMARY_MIDNIGHT_TICK_MINUTES/u);
    assert.match(source, /if \(localClockMinutes\(\) >= CALENDAR_SUMMARY_MIDNIGHT_TICK_MINUTES\) return;/u);
    assert.match(source, /daily=00:00-local/u);
    assert.match(source, /weekly=Sunday-24:00\/Monday-00:00-local/u);
    assert.match(source, /monthly=last-day-24:00\/next-month-00:00-local/u);
});
