import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const databaseSource = await readFile(new URL('../../src/infrastructure/database/index.js', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

test('V177 has a durable lossless VK archive table', () => {
    assert.match(databaseSource, /CREATE TABLE IF NOT EXISTS vk_message_archive/);
    assert.match(databaseSource, /action_type TEXT NOT NULL DEFAULT ''/);
    assert.match(databaseSource, /action_json TEXT NOT NULL DEFAULT ''/);
    assert.match(databaseSource, /raw_message_json TEXT NOT NULL DEFAULT ''/);
    assert.match(databaseSource, /PRIMARY KEY \(source_peer_id, conversation_message_id\)/);
    assert.match(databaseSource, /vk-message-archive-journal\.jsonl/);
});

test('V177 archives live VK payloads before higher-level command logic can discard service metadata', () => {
    assert.match(appSource, /archiveVkMessageFromMessage\(rawVkMessage,[\s\S]*?durableJournal: true/);
    assert.match(appSource, /\[VK LIVE ARCHIVE SAVE ERROR\]/);
});

test('V177 CMID backfill archives every returned VK object before filtering semantic incoming messages', () => {
    const archiveIndex = appSource.indexOf('archiveVkMessageFromMessage(item, {');
    const outboxFilterIndex = appSource.indexOf("if (Number(item?.out || 0) === 1) continue;", archiveIndex);
    assert.ok(archiveIndex >= 0, 'archive call missing');
    assert.ok(outboxFilterIndex > archiveIndex, 'archive must happen before outbox filtering');
});

test('V188.23 keeps service reports but removes automatic deep archive crawling', () => {
    assert.doesNotMatch(appSource, /vk-archive-recovery-v177:/);
    assert.doesNotMatch(appSource, /runVkArchiveRecovery\(/);
    assert.match(appSource, /parseServiceEventsReportCommand/);
    assert.match(appSource, /parseVkHistoryPullCommand/);
    assert.match(appSource, /Все найденные служебные события/);
});
