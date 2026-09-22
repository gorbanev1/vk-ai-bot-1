import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The database/index.js module performs startup migrations on import.
// Execute it in a child with a unique disposable database directory so this
// test can never read or write a working bot.sqlite.
test('VK Chat raw source + events commit together and roll back together', () => {
    const isolatedDirectory = mkdtempSync(join(tmpdir(), 'gigorave-atomic-vk-chat-'));
    const source = String.raw`
        const { persistVkChatSourceAndEvents, getVkChatMessageMeta } = await import(process.env.GIGORAVE_TEST_DB_MODULE_URL);
        const base = { peerId:222, conversationMessageId:12345,
            conversationUrl:'https://vk.ru/im?sel=c222', conversationName:'test',
            senderId:17, createdAt:1, rawText:'original', links:[], imageUrls:[],
            imagePaths:[], contentHash:'hash1', parseStatus:'event', fetchedAt:1 };
        const replacement = { peerId:222, conversationMessageId:12345,
            sourceUrl:base.conversationUrl, imagePaths:[], events:[], updatedAt:1 };
        persistVkChatSourceAndEvents({source:base,replacement});
        const initial = getVkChatMessageMeta({peerId:222,conversationMessageId:12345});
        if (initial?.rawText !== 'original') throw Error('initial source write failed');
        let rejected=false;
        try {
            persistVkChatSourceAndEvents({source:{...base,rawText:'MUST_ROLLBACK',contentHash:'hash2'},
                replacement:{...replacement, events:[{eventDate:'2026-09-30',title:{
                    toString(){throw Error('injected-write-failure');}
                }}]}});
        } catch(error) {
            if (!String(error?.message).includes('injected-write-failure')) throw error;
            rejected=true;
        }
        if(!rejected) throw Error('injected failure not triggered');
        const after = getVkChatMessageMeta({peerId:222,conversationMessageId:12345});
        if(after?.rawText!=='original' || after.contentHash!=='hash1') {
            throw Error('source was committed despite events failure');
        }
        console.log('ATOMIC_VK_CHAT_OK');
    `;
    try {
        const output = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
            cwd: process.cwd(), encoding: 'utf8', timeout: 25_000,
            env: { ...process.env, NODE_ENV: 'test', GIGORAVE_DATA_DIR: isolatedDirectory,
                GIGORAVE_DB_PATH: join(isolatedDirectory, 'bot.sqlite'),
                GIGORAVE_TEST_DB_MODULE_URL: pathToFileURL(join(process.cwd(), 'src/infrastructure/database/index.js')).href,
                QTICKETS_DB_PATH: join(isolatedDirectory, 'qtickets.sqlite') },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        assert.match(output, /ATOMIC_VK_CHAT_OK/u);
    } finally {
        rmSync(isolatedDirectory, { recursive: true, force: true });
    }
});
