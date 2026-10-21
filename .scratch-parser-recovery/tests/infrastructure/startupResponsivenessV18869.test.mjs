import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appUrl = new URL('../../src/app/botApplication.js', import.meta.url);
const recoveryUrl = new URL('../../src/features/history/localSqliteHistoryRecovery.js', import.meta.url);

test('V188.69: startup marks bot ready before delayed history recovery begins', async () => {
    const source = await readFile(appUrl, 'utf8');
    assert.match(source, /VK_HISTORY_STARTUP_DELAY_MS/u);
    assert.match(source, /setTimeout\(\(\) => \{\s*runDetachedSupervisedOperation\(\{ name: 'vk-history-recovery:startup'/u);
    assert.match(source, /\[BOT READY\]/u);
    assert.match(source, /commands=available-now/u);

    const readyIndex = source.indexOf("'[BOT READY]'");
    const periodicIndex = source.indexOf('const vkHistoryRecoveryTimer = setInterval');
    assert.ok(readyIndex > 0);
    assert.ok(periodicIndex > 0);
});

test('V188.69: local SQLite history recovery yields between bounded batches', async () => {
    const source = await readFile(recoveryUrl, 'utf8');
    assert.match(source, /export async function recoverHistoryFromLocalSqliteBackups/u);
    assert.match(source, /batchSize = 250/u);
    assert.match(source, /LIMIT \?/u);
    assert.match(source, /ORDER BY rowid ASC/u);
    assert.match(source, /await yieldToEventLoop\(\)/u);
    assert.doesNotMatch(source, /return database\.prepare\(`\s*SELECT peer_id, sender_id, conversation_message_id, text, created_at\s*FROM messages NOT INDEXED\s*WHERE peer_id IN \(\$\{placeholders\}\)\s*`\)\.all/u);
});
