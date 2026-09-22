import assert from 'node:assert/strict';
import test from 'node:test';
import {
    cpSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

test('V116 upgrades legacy post_event_feedback_requests before preparing statements', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gigorave-v116-migration-'));
    try {
        const databaseSource = new URL('../../src/infrastructure/database/index.js', import.meta.url);
        const targetModule = join(root, 'src', 'infrastructure', 'database', 'index.js');
        const dateEvidenceSource = new URL('../../src/features/events/publicPostDateEvidence.js', import.meta.url);
        const dateEvidenceTarget = join(root, 'src', 'features', 'events', 'publicPostDateEvidence.js');
        const autoSummaryStoreSource = new URL('../../src/infrastructure/database/autoSummaryStateStore.js', import.meta.url);
        const autoSummaryStoreTarget = join(root, 'src', 'infrastructure', 'database', 'autoSummaryStateStore.js');
        const dataDirectory = join(root, 'data');
        mkdirSync(join(root, 'src', 'infrastructure', 'database'), { recursive: true });
        mkdirSync(join(root, 'src', 'features', 'events'), { recursive: true });
        mkdirSync(dataDirectory, { recursive: true });
        cpSync(databaseSource, targetModule);
        cpSync(dateEvidenceSource, dateEvidenceTarget);
        cpSync(autoSummaryStoreSource, autoSummaryStoreTarget);
        process.env.GIGORAVE_STATE_DIR = join(root, 'state');
        writeFileSync(join(root, 'package.json'), '{"type":"module"}\n', 'utf8');

        const legacy = new DatabaseSync(join(dataDirectory, 'bot.sqlite'));
        legacy.exec(`
            CREATE TABLE post_event_feedback_requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                campaign_key TEXT NOT NULL,
                platform TEXT NOT NULL CHECK (platform IN ('vk', 'telegram')),
                endpoint_key TEXT NOT NULL,
                external_user_id TEXT NOT NULL,
                external_peer_id TEXT NOT NULL,
                sent_at INTEGER NOT NULL,
                awaiting_feedback INTEGER NOT NULL DEFAULT 1 CHECK (awaiting_feedback IN (0, 1)),
                UNIQUE (campaign_key, platform, endpoint_key, external_user_id)
            );
            INSERT INTO post_event_feedback_requests (
                campaign_key,
                platform,
                endpoint_key,
                external_user_id,
                external_peer_id,
                sent_at,
                awaiting_feedback
            ) VALUES ('legacy', 'telegram', 'telegram', '1', '1', 100, 1);
        `);
        legacy.close();

        const databaseModule = await import(`${pathToFileURL(targetModule).href}?v116=${Date.now()}`);
        const armed = databaseModule.armPostEventFeedbackRecipients({
            campaignKey: 'v116-new',
            recipients: [{
                platform: 'telegram',
                endpointKey: 'telegram',
                externalUserId: '2',
                externalPeerId: '2',
            }],
            sentAt: 200,
        });
        assert.equal(armed, 1);
        assert.ok(databaseModule.getPendingPostEventFeedbackRequest({
            campaignKey: 'v116-new',
            platform: 'telegram',
            endpointKey: 'telegram',
            externalUserId: '2',
        }));

        const check = new DatabaseSync(join(dataDirectory, 'bot.sqlite'));
        const columns = check.prepare('PRAGMA table_info(post_event_feedback_requests)').all();
        const migratedColumn = columns.find((row) => row.name === 'feedback_received_at');
        assert.ok(migratedColumn, 'feedback_received_at column must be added');
        assert.equal(Number(migratedColumn.notnull), 1);
        assert.equal(String(migratedColumn.dflt_value), '0');
        const legacyRow = check.prepare(`
            SELECT feedback_received_at
            FROM post_event_feedback_requests
            WHERE campaign_key = 'legacy'
        `).get();
        assert.equal(Number(legacyRow.feedback_received_at), 0);
        check.close();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
