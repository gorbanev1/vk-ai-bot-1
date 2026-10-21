import test from 'node:test';
import assert from 'node:assert/strict';
import { explainRecentOrFuturePost } from '../../src/features/scrapers/recentEventPassPolicy.js';

const now = new Date('2026-10-03T12:00:00+03:00');

test('recent post is admitted', () => {
    const result = explainRecentOrFuturePost({
        publishedAt: Math.floor(new Date('2026-10-02T12:00:00+03:00').getTime() / 1000),
        text: 'Концерт 1 октября', referenceNow: now, recentDays: 3,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.reason, 'recent-post');
});

test('old post with future event date is admitted', () => {
    const result = explainRecentOrFuturePost({
        publishedAt: Math.floor(new Date('2026-09-01T12:00:00+03:00').getTime() / 1000),
        text: 'Концерт 12 октября 2026', referenceNow: now, recentDays: 3,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.reason, 'future-event-date');
});

test('old post changed since the last captured version is admitted', () => {
    const result = explainRecentOrFuturePost({
        publishedAt: Math.floor(new Date('2026-09-01T12:00:00+03:00').getTime() / 1000),
        text: 'Обновленный анонс без точной даты', referenceNow: now, recentDays: 3, contentChanged: true,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.reason, 'content-changed-since-last-capture');
});

test('old post without future date is filtered', () => {
    const result = explainRecentOrFuturePost({
        publishedAt: Math.floor(new Date('2026-09-01T12:00:00+03:00').getTime() / 1000),
        text: 'Концерт 1 сентября 2026', referenceNow: now, recentDays: 3,
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'stale-post-outside-recent-window');
});

test('unknown timestamp is retained to prevent silent card loss', () => {
    const result = explainRecentOrFuturePost({ text: 'Анонс без даты', referenceNow: now, recentDays: 3 });
    assert.equal(result.allowed, true);
    assert.equal(result.reason, 'unknown-post-date');
});
