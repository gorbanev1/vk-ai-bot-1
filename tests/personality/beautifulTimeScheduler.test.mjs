import test from 'node:test';
import assert from 'node:assert/strict';
import {
    BEAUTIFUL_TIME_MODES, buildBeautifulTimeSchedule, createBeautifulTimeScheduler,
    formatBeautifulTimeMessage, isBeautifulDate, isBeautifulTime, parseBeautifulTimeCommand,
} from '../../src/features/personality/beautifulTimeScheduler.js';

const timestamp = (iso) => Date.parse(iso);
const constantRandom = () => 0;

test('beautiful-time commands accept bot addressing and keep disable priority', () => {
    assert.equal(parseBeautifulTimeCommand('гигорейв фиксируй время'), BEAUTIFUL_TIME_MODES.TIME);
    assert.equal(parseBeautifulTimeCommand('Гигорейв, фиксируй дату и время!'), BEAUTIFUL_TIME_MODES.DATE_TIME);
    assert.equal(parseBeautifulTimeCommand('@Gigorave_bot отмечай время'), BEAUTIFUL_TIME_MODES.TIME);
    assert.equal(parseBeautifulTimeCommand('гигорейв фиксируй время стоп'), 'stop');
    assert.equal(parseBeautifulTimeCommand('гигорейв ну фиксируй время'), '');
});

test('beautiful time predicate covers documented categories without broad adjacent-minute matches', () => {
    for (const [hour, minute] of [[1, 11], [11, 11], [22, 22], [10, 10], [12, 21], [13, 31], [1, 23], [12, 34], [11, 22], [22, 11], [0, 0], [2, 2]]) {
        assert.equal(isBeautifulTime(hour, minute), true, `${hour}:${minute}`);
    }
    assert.equal(isBeautifulTime(12, 13), false);
    assert.equal(isBeautifulTime(15, 27), false);
});

test('beautiful dates cover same day/month, repeated digits, palindrome and sequence examples', () => {
    for (const date of [
        { day: 1, month: 1, year: 2027 }, { day: 2, month: 2, year: 2027 },
        { day: 20, month: 2, year: 2020 }, { day: 22, month: 2, year: 2022 },
        { day: 2, month: 2, year: 2020 }, { day: 12, month: 2, year: 2021 },
        { day: 1, month: 2, year: 2003 }, { day: 2, month: 3, year: 2004 },
    ]) assert.equal(isBeautifulDate(date), true, JSON.stringify(date));
    assert.equal(isBeautifulDate({ day: 3, month: 4, year: 2027 }), false);
});

test('mode time schedules beautiful date once and beautiful times; simultaneous midnight is one combined entry', () => {
    const schedule = buildBeautifulTimeSchedule({
        mode: BEAUTIFUL_TIME_MODES.TIME, timeZone: 'Europe/Moscow',
        now: timestamp('2026-11-10T20:59:00Z'), days: 1, random: constantRandom,
    });
    const midnight = schedule.filter(job => job.date === '2026-11-11' && job.time === '00:00');
    assert.equal(midnight.length, 1);
    assert.equal(midnight[0].message, '🔥 11.11.2026 00:00 🔥');
    assert.equal(schedule.some(job => job.date === '2026-11-11' && job.time === '01:01'), true);
    assert.equal(schedule.some(job => job.date === '2026-11-11' && job.time === '00:27'), false);
    assert.equal(schedule.some(job => job.date === '2026-11-11' && job.time === '15:27'), false);
});

test('date_time mode only schedules beautiful minutes on a beautiful date', () => {
    const ordinaryDateSchedule = buildBeautifulTimeSchedule({
        mode: BEAUTIFUL_TIME_MODES.DATE_TIME, timeZone: 'Europe/Moscow',
        now: timestamp('2026-10-20T20:59:00Z'), days: 1, random: constantRandom,
    });
    assert.equal(ordinaryDateSchedule.length, 0);
    const beautifulDateSchedule = buildBeautifulTimeSchedule({
        mode: BEAUTIFUL_TIME_MODES.DATE_TIME, timeZone: 'Europe/Moscow',
        now: timestamp('2026-11-10T20:59:00Z'), days: 1, random: constantRandom,
    });
    assert.equal(beautifulDateSchedule.every(job => job.beautifulDate && job.beautifulTime), true);
    assert.equal(beautifulDateSchedule.length > 0, true);
    assert.equal(formatBeautifulTimeMessage({
        date: { day: 11, month: 11, year: 2026 }, time: '11:11',
        beautifulDate: true, beautifulTime: true, mode: BEAUTIFUL_TIME_MODES.DATE_TIME, random: constantRandom,
    }).message, '🔥 11.11.2026 11:11 🔥');
});

test('schedule advances through a DST transition by real instants without imaginary local minutes', () => {
    const schedule = buildBeautifulTimeSchedule({
        mode: BEAUTIFUL_TIME_MODES.TIME, timeZone: 'Europe/Berlin',
        now: timestamp('2026-03-28T22:59:00Z'), days: 1, random: constantRandom,
    });
    assert.equal(schedule.some(job => job.date === '2026-03-29' && job.time === '02:02'), false);
    assert.equal(schedule.every((job, index) => index === 0 || job.scheduledAt > schedule[index - 1].scheduledAt), true);
});

test('durable manager persists prepared text, sends once and marks missed minutes without retroactive delivery', async () => {
    let current = timestamp('2026-11-10T20:59:00Z');
    let state = { version: 1, conversations: {} };
    const sent = [];
    const timers = [];
    const scheduler = createBeautifulTimeScheduler({
        loadState: () => state, saveState: next => { state = structuredClone(next); },
        send: async (_target, message) => sent.push(message), now: () => current,
        setTimer: callback => { timers.push(callback); return { unref() {} }; }, clearTimer() {}, random: constantRandom,
    });
    scheduler.activate({ platform: 'vk', endpointKey: 'vk:primary', peerId: 1, externalPeerId: '1', timeZone: 'Europe/Moscow' }, BEAUTIFUL_TIME_MODES.TIME);
    const job = Object.values(state.conversations)[0].queue.find(item => item.time === '00:00');
    assert.ok(job);
    assert.equal(job.message, '🔥 11.11.2026 00:00 🔥');

    current = job.scheduledAt;
    await scheduler.tick();
    await scheduler.tick();
    assert.deepEqual(sent, [job.message]);
    assert.equal(Object.values(state.conversations)[0].queue.find(item => item.id === job.id).status, 'sent');

    const next = Object.values(state.conversations)[0].queue.find(item => item.status === 'scheduled' && item.scheduledAt > job.scheduledAt);
    current = next.scheduledAt + 120_000;
    await scheduler.tick();
    assert.equal(Object.values(state.conversations)[0].queue.find(item => item.id === next.id).status, 'missed');
});

test('mode switch replaces future jobs and disable cancels jobs while preserving sent history', async () => {
    let current = timestamp('2026-11-10T20:59:00Z');
    let state = { version: 1, conversations: {} };
    const scheduler = createBeautifulTimeScheduler({
        loadState: () => state, saveState: next => { state = structuredClone(next); },
        send: async () => {}, now: () => current, setTimer: () => ({ unref() {} }), clearTimer() {}, random: constantRandom,
    });
    const target = { platform: 'vk', endpointKey: 'vk:primary', peerId: 7, externalPeerId: '7', timeZone: 'Europe/Moscow' };
    scheduler.activate(target, BEAUTIFUL_TIME_MODES.TIME);
    const key = Object.keys(state.conversations)[0];
    const timeQueue = state.conversations[key].queue;
    assert.ok(timeQueue.some(job => job.mode === BEAUTIFUL_TIME_MODES.TIME));
    scheduler.activate(target, BEAUTIFUL_TIME_MODES.DATE_TIME);
    assert.ok(state.conversations[key].queue.every(job => job.mode === BEAUTIFUL_TIME_MODES.DATE_TIME));
    state.conversations[key].history.push({ id: 'sent-before-disable', status: 'sent' });
    assert.equal(scheduler.deactivate(target), true);
    assert.equal(state.conversations[key].mode, '');
    assert.ok(state.conversations[key].queue.every(job => job.status !== 'scheduled'));
    assert.equal(state.conversations[key].history[0].id, 'sent-before-disable');
});
