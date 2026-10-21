import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { resolveMainDatabasePath } from '../src/infrastructure/database/runtimePaths.js';

const { values } = parseArgs({
    options: {
        archive: { type: 'string' },
        database: { type: 'string' },
        'from-date': { type: 'string' },
    },
});
if (!values.archive) throw new Error('Use --archive <latest-parser-archive>; this audit never searches older runs.');
const archive = resolve(values.archive);
const fromDate = values['from-date'] || new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(fromDate)) throw new Error('Invalid --from-date; expected YYYY-MM-DD.');
const wallOwner = (url) => Number(String(url || '').match(/wall(-?[0-9]+)_[0-9]+/u)?.[1] || 0);
const groups = new Map();
let cacheFiles = 0;
let capturedPosts = 0;
for (const name of readdirSync(archive).filter((name) => name.endsWith('.raw-cache.json'))) {
    const cache = JSON.parse(readFileSync(join(archive, name), 'utf8'));
    if (cache.kind !== 'vk-public') continue;
    cacheFiles += 1;
    for (const item of Array.isArray(cache.items) ? cache.items : []) {
        const screenName = String(item.screenName || cache.sourceId?.replace(/^vk:/u, '') || '');
        const postId = Number(item.postId);
        if (!screenName || !Number.isSafeInteger(postId) || postId <= 0) continue;
        capturedPosts += 1;
        const key = JSON.stringify([screenName, postId]);
        const group = groups.get(key) || { screenName, postId, owners: new Set(), urls: new Set() };
        group.owners.add(Number(item.ownerId || wallOwner(item.sourceUrl)));
        if (item.sourceUrl) group.urls.add(String(item.sourceUrl));
        groups.set(key, group);
    }
}

// Do not import database/index.js: that module runs migrations on import.
const databasePath = resolve(values.database || resolveMainDatabasePath());
const db = new DatabaseSync(databasePath, { readOnly: true });
try {
    const sourceQuery = db.prepare(`
        SELECT owner_id AS ownerId, source_url AS sourceUrl, parse_status AS parseStatus
        FROM vk_source_posts WHERE screen_name = ? AND post_id = ?
    `);
    const eventQuery = db.prepare(`
        SELECT id, event_index AS eventIndex, event_date AS eventDate, source_url AS sourceUrl
        FROM vk_events WHERE screen_name = ? AND post_id = ? AND event_date >= ?
        ORDER BY id
    `);
    const ledgerQuery = db.prepare(`
        SELECT item_id AS itemId, source_url AS sourceUrl, parse_status AS parseStatus
        FROM manual_parser_seen_items WHERE source_id = ? AND item_id = ?
    `);
    const conflicts = [];
    const missingOwner = [];
    db.exec('BEGIN');
    for (const group of groups.values()) {
        if (group.owners.has(0)) missingOwner.push({ screenName: group.screenName, postId: group.postId });
        const source = sourceQuery.get(group.screenName, group.postId) || null;
        const ledger = ledgerQuery.get(`vk:${group.screenName}`, String(group.postId)) || null;
        const events = eventQuery.all(group.screenName, group.postId, fromDate);
        const observedOwners = new Set([...group.owners, Number(source?.ownerId || 0),
            wallOwner(ledger?.sourceUrl), ...events.map((row) => wallOwner(row.sourceUrl))].filter(Boolean));
        if (observedOwners.size <= 1) continue;
        conflicts.push({
            screenName: group.screenName, postId: group.postId,
            capturedOwners: [...group.owners], observedOwners: [...observedOwners],
            capturedUrls: [...group.urls], source, ledger, futureEvents: events,
        });
    }
    db.exec('COMMIT');
    console.log(JSON.stringify({
        readOnly: true, archive, databasePath, fromDate, cacheFiles, capturedPosts,
        distinctLegacyKeys: groups.size, conflictCount: conflicts.length,
        missingOwner, conflicts,
    }, null, 2));
} finally {
    db.close();
}
