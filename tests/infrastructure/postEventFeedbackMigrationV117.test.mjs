import assert from 'node:assert/strict';
import test from 'node:test';
import {
    cpSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

async function loadDatabaseModuleWithLegacySchema(schemaSql, tag) {
    const root = mkdtempSync(join(tmpdir(), `gigorave-v117-${tag}-`));
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
    legacy.exec(schemaSql);
    legacy.close();

    const module = await import(`${pathToFileURL(targetModule).href}?v117=${tag}-${Date.now()}-${Math.random()}`);
    return {
        root,
        databasePath: join(dataDirectory, 'bot.sqlite'),
        module,
    };
}

function assertCanonicalRequestSchema(databasePath) {
    const check = new DatabaseSync(databasePath);
    const columns = check.prepare('PRAGMA table_info(post_event_feedback_requests)').all();
    const byName = new Map(columns.map((row) => [String(row.name), row]));
    assert.ok(byName.has('id'), 'canonical schema must contain id');
    assert.equal(Number(byName.get('id').pk), 1, 'id must be the primary key');
    assert.ok(byName.has('feedback_received_at'), 'canonical schema must contain feedback_received_at');

    const uniqueIndexes = check.prepare("PRAGMA index_list('post_event_feedback_requests')").all();
    const canonicalUnique = uniqueIndexes.some((indexRow) => {
        if (!Number(indexRow.unique)) return false;
        const escapedName = String(indexRow.name).replaceAll("'", "''");
        const names = check.prepare(`PRAGMA index_info('${escapedName}')`).all().map((row) => String(row.name));
        return names.join('|') === 'campaign_key|platform|endpoint_key|external_user_id';
    });
    assert.ok(canonicalUnique, 'canonical composite UNIQUE key must exist');
    check.close();
}

test('V117 rebuilds legacy feedback request table without id and preserves pending rows', async () => {
    const fixture = await loadDatabaseModuleWithLegacySchema(`
        CREATE TABLE post_event_feedback_requests (
            campaign_key TEXT NOT NULL,
            platform TEXT NOT NULL,
            endpoint_key TEXT NOT NULL,
            external_user_id TEXT NOT NULL,
            external_peer_id TEXT NOT NULL,
            sent_at INTEGER NOT NULL,
            awaiting_feedback INTEGER NOT NULL DEFAULT 1,
            feedback_received_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (campaign_key, platform, endpoint_key, external_user_id)
        );
        INSERT INTO post_event_feedback_requests (
            campaign_key, platform, endpoint_key, external_user_id,
            external_peer_id, sent_at, awaiting_feedback, feedback_received_at
        ) VALUES ('legacy-no-id', 'telegram', 'telegram', '101', '101', 100, 1, 0);
    `, 'no-id');

    try {
        assertCanonicalRequestSchema(fixture.databasePath);
        const pending = fixture.module.getPendingPostEventFeedbackRequest({
            campaignKey: 'legacy-no-id',
            platform: 'telegram',
            endpointKey: 'telegram',
            externalUserId: '101',
        });
        assert.ok(pending);
        assert.ok(Number(pending.id) > 0);
        assert.equal(pending.externalPeerId, '101');

        const reviewId = fixture.module.savePostEventFeedbackReview({
            campaignKey: 'legacy-no-id',
            platform: 'telegram',
            endpointKey: 'telegram',
            externalUserId: '101',
            externalPeerId: '101',
            reviewText: 'legacy schema survived',
            receivedAt: 200,
        });
        assert.ok(reviewId > 0);
        assert.equal(fixture.module.getPendingPostEventFeedbackRequest({
            campaignKey: 'legacy-no-id',
            platform: 'telegram',
            endpointKey: 'telegram',
            externalUserId: '101',
        }), null);
    } finally {
        rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('V117 repairs no-id/no-feedback/no-unique legacy table and deduplicates recipients', async () => {
    const fixture = await loadDatabaseModuleWithLegacySchema(`
        CREATE TABLE post_event_feedback_requests (
            campaign_key TEXT NOT NULL,
            platform TEXT NOT NULL,
            endpoint_key TEXT NOT NULL,
            external_user_id TEXT NOT NULL,
            external_peer_id TEXT NOT NULL,
            sent_at INTEGER NOT NULL,
            awaiting_feedback INTEGER NOT NULL DEFAULT 1
        );
        INSERT INTO post_event_feedback_requests VALUES
            ('legacy-duplicate', 'vk', 'main', '55', '550', 100, 1),
            ('legacy-duplicate', 'vk', 'main', '55', '551', 150, 1);
    `, 'no-id-no-feedback-no-unique');

    try {
        assertCanonicalRequestSchema(fixture.databasePath);
        const check = new DatabaseSync(fixture.databasePath);
        const rows = check.prepare(`
            SELECT campaign_key, platform, endpoint_key, external_user_id, sent_at, feedback_received_at
            FROM post_event_feedback_requests
            WHERE campaign_key = 'legacy-duplicate'
        `).all();
        assert.equal(rows.length, 1, 'duplicate legacy recipients must be collapsed');
        assert.equal(Number(rows[0].sent_at), 150);
        assert.equal(Number(rows[0].feedback_received_at), 0);
        check.close();

        assert.equal(fixture.module.armPostEventFeedbackRecipients({
            campaignKey: 'legacy-duplicate',
            recipients: [{
                platform: 'vk',
                endpointKey: 'main',
                externalUserId: '55',
                externalPeerId: '552',
            }],
            sentAt: 300,
        }), 1);
        const stats = fixture.module.getPostEventFeedbackStats({ campaignKey: 'legacy-duplicate' });
        assert.equal(stats.sent, 1);
        assert.equal(stats.awaiting, 1);
    } finally {
        rmSync(fixture.root, { recursive: true, force: true });
    }
});
