import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CALENDAR_LONG_ROLLUP_CATCHUP_SECONDS,
    calendarPeriodClosedWithinCatchup,
    getDueCalendarLongRollups,
    getDueCalendarDailySummaryKeys,
    getDueCalendarSpecialRollups,
    selectCalendarSummarySourcesForPeriod,
} from '../../src/features/ai/calendarSummarySchedule.js';

const TZ = 'Europe/Moscow';

test('special weekly summaries remain due after their scheduled minute was missed', () => {
    const due = getDueCalendarSpecialRollups(new Date('2026-10-20T07:38:00.000Z'), TZ);

    assert.deepEqual(due.map(({ periodType, periodKey }) => [periodType, periodKey]), [
        ['workweek', '2026-10-16'],
        ['weekend', '2026-10-18'],
        ['full-week', '2026-10-18'],
    ]);
    assert.deepEqual(due.map(({ startDate, endDate, endHour, endMinute }) => [startDate, endDate, endHour, endMinute]), [
        ['2026-10-12', '2026-10-16', 15, 0],
        ['2026-10-16', '2026-10-18', 20, 0],
        ['2026-10-12', '2026-10-18', 21, 0],
    ]);
});

test('special weekly summary catch-up is bounded and excludes future scheduled windows', () => {
    const now = new Date('2026-10-20T21:01:00.000Z');
    assert.deepEqual(getDueCalendarSpecialRollups(now, TZ, 60 * 60), []);

    const recent = getDueCalendarSpecialRollups(now, TZ, 7 * 24 * 60 * 60);
    assert.deepEqual(recent.map(({ periodType }) => periodType), ['workweek', 'weekend', 'full-week']);
});

test('daily summary catch-up includes yesterday after midnight and excludes old or open days', () => {
    const due = getDueCalendarDailySummaryKeys(
        ['2026-10-10', '2026-10-18', '2026-10-19', '2026-10-19'],
        new Date('2026-10-20T07:38:00.000Z'),
        TZ,
    );

    assert.deepEqual(due, ['2026-10-19', '2026-10-18']);
});

test('partial-day rollups use batch summaries for uncovered boundary days', () => {
    const selection = selectCalendarSummarySourcesForPeriod(
        [
            { dayKey: 'monday', startAt: 0, endAt: 100 },
            { dayKey: 'friday', startAt: 400, endAt: 500 },
        ],
        [
            { dayKey: 'monday', startAt: 0, endAt: 25 },
            { dayKey: 'friday', startAt: 400, endAt: 425 },
            { dayKey: 'friday', startAt: 425, endAt: 450 },
            { dayKey: 'friday', startAt: 450, endAt: 475 },
            { dayKey: 'friday', startAt: 475, endAt: 500 },
            { dayKey: 'saturday', startAt: 500, endAt: 600 },
        ],
        0,
        450,
    );

    assert.deepEqual(selection.daily.map((row) => row.dayKey), ['monday']);
    assert.deepEqual(selection.batches.map((row) => row.dayKey), ['friday', 'friday']);
});

test('monthly, seasonal and yearly summaries are due on the first day at their scheduled local times', () => {
    const month = getDueCalendarLongRollups(new Date('2026-10-01T08:05:00.000Z'), TZ, 14 * 24 * 60 * 60);
    assert.deepEqual(month.map(({ periodType, periodKey, startDate, endDate, scheduledAt }) => ({
        periodType, periodKey, startDate, endDate, time: new Date(scheduledAt * 1000).toISOString(),
    })), [{
        periodType: 'calendar-month', periodKey: '2026-09', startDate: '2026-09-01', endDate: '2026-10-01',
        time: '2026-10-01T08:00:00.000Z',
    }]);

    const season = getDueCalendarLongRollups(new Date('2026-12-01T08:05:00.000Z'), TZ, 14 * 24 * 60 * 60);
    assert.deepEqual(season.map(({ periodType, periodKey, startDate, endDate }) => [periodType, periodKey, startDate, endDate]), [
        ['calendar-month', '2026-11', '2026-11-01', '2026-12-01'],
        ['calendar-season', 'autumn:2026-09-01', '2026-09-01', '2026-12-01'],
    ]);

    const year = getDueCalendarLongRollups(new Date('2027-01-01T09:05:00.000Z'), TZ, 14 * 24 * 60 * 60);
    assert.deepEqual(year.map(({ periodType, periodKey, startDate, endDate }) => [periodType, periodKey, startDate, endDate]), [
        ['calendar-month', '2026-12', '2026-12-01', '2027-01-01'],
        ['calendar-year', '2026', '2026-01-01', '2027-01-01'],
    ]);
});

test('each new season publishes the immediately preceding season', () => {
    const cases = [
        ['2026-03-01T08:05:00.000Z', ['winter', '2025-12-01', '2026-03-01']],
        ['2026-06-01T08:05:00.000Z', ['spring', '2026-03-01', '2026-06-01']],
        ['2026-09-01T08:05:00.000Z', ['summer', '2026-06-01', '2026-09-01']],
        ['2026-12-01T08:05:00.000Z', ['autumn', '2026-09-01', '2026-12-01']],
    ];

    for (const [now, expected] of cases) {
        const season = getDueCalendarLongRollups(new Date(now), TZ, 14 * 24 * 60 * 60)
            .find(({ periodType }) => periodType === 'calendar-season');
        assert.ok(season, `missing season rollup at ${now}`);
        assert.deepEqual([season.periodKey.split(':')[0], season.startDate, season.endDate], expected);
        assert.equal(new Date(season.scheduledAt * 1000).toISOString().slice(11, 16), '08:00');
    }
});

test('long rollup catch-up can deliver recent monthly, seasonal and yearly summaries after a missed tick', () => {
    const month = getDueCalendarLongRollups(new Date('2026-10-03T08:00:00.000Z'), TZ);
    assert.ok(month.some(({ periodType, periodKey }) => periodType === 'calendar-month' && periodKey === '2026-09'));

    const season = getDueCalendarLongRollups(new Date('2026-12-03T08:00:00.000Z'), TZ);
    assert.ok(season.some(({ periodType, periodKey }) => periodType === 'calendar-season' && periodKey === 'autumn:2026-09-01'));

    const year = getDueCalendarLongRollups(new Date('2027-01-03T09:00:00.000Z'), TZ);
    assert.ok(year.some(({ periodType, periodKey }) => periodType === 'calendar-year' && periodKey === '2026'));
});

test('monthly rollup remains due after a 19-day bot outage, before the new season starts', () => {
    const due = getDueCalendarLongRollups(new Date('2026-10-20T08:00:00.000Z'), TZ);
    assert.ok(due.some(({ periodType, periodKey }) => periodType === 'calendar-month' && periodKey === '2026-09'));
    assert.ok(!due.some(({ periodType }) => periodType === 'calendar-season'));
});

test('month delivery catch-up accepts a 19-day outage and still rejects future periods', () => {
    const now = new Date('2026-10-20T08:00:00.000Z');
    assert.equal(calendarPeriodClosedWithinCatchup('2026-10-01', now, CALENDAR_LONG_ROLLUP_CATCHUP_SECONDS, TZ), true);
    assert.equal(calendarPeriodClosedWithinCatchup('2026-10-01', now, 14 * 24 * 60 * 60, TZ), false);
    assert.equal(calendarPeriodClosedWithinCatchup('2026-11-01', now, CALENDAR_LONG_ROLLUP_CATCHUP_SECONDS, TZ), false);
});
