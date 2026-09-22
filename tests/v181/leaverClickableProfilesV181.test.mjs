import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const botSource = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const reportBlock = botSource.slice(
    botSource.indexOf('function formatVkProfileMention'),
    botSource.indexOf('function parseServiceEventsReportCommand'),
);

test('V181+ leaver report renders clickable VK profile names', () => {
    assert.match(reportBlock, /return `\[id\$\{numericId\}\|\$\{name\}\]`/);
    assert.match(reportBlock, /formatVkProfileMention\(memberId, names\)/);
    assert.match(reportBlock, /formatVkProfileMention\(actorId, names\)/);
    assert.doesNotMatch(reportBlock, /https?:\/\/vk\.(?:com|ru)\/im/);
    assert.doesNotMatch(reportBlock, /https?:\/\/vk\.(?:com|ru)\/id/);
});

test('V181+ keeps exact exit timestamp output from V180', () => {
    assert.match(reportBlock, /formatMembershipExitDateTime\(event\.createdAt\)/);
    assert.match(reportBlock, /сам вышел/);
    assert.match(reportBlock, /исключён/);
});
