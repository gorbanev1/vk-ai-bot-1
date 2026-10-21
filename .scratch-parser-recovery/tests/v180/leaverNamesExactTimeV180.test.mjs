import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const botSource = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const dbSource = await readFile(new URL('../../src/infrastructure/database/index.js', import.meta.url), 'utf8');
const reportBlock = botSource.slice(
    botSource.indexOf('async function buildLeftMembersReport'),
    botSource.indexOf('function parseServiceEventsReportCommand'),
);

test('V180+ leaver report resolves durable profile names', () => {
    assert.match(reportBlock, /const names = await loadNames\(idsForNames\)/);
    assert.match(reportBlock, /formatVkProfileMention\(memberId, names\)/);
    assert.doesNotMatch(reportBlock, /https?:\/\/vk\.(?:com|ru)\/id/);
});

test('V180+ leaver report contains every exit event with exact date and time', () => {
    assert.match(reportBlock, /getChatExitEvents\(numericPeerId/);
    assert.match(botSource, /hour: '2-digit'/);
    assert.match(botSource, /minute: '2-digit'/);
    assert.match(botSource, /second: '2-digit'/);
    assert.match(reportBlock, /for \(const event of events\)/);
    assert.match(reportBlock, /сам вышел/);
    assert.match(reportBlock, /исключил:/);
});

test('V180 stores a durable VK user-name cache in bot.sqlite', () => {
    assert.match(dbSource, /CREATE TABLE IF NOT EXISTS vk_user_name_cache/);
    assert.match(dbSource, /export function getVkCachedUserNames/);
    assert.match(dbSource, /export function saveVkUserNames/);
    assert.match(dbSource, /export function getChatExitEvents/);
});
