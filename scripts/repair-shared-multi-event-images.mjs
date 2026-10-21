import { DatabaseSync } from 'node:sqlite';

function argument(name, fallback = '') {
    const index = process.argv.indexOf(name);
    return index >= 0 ? String(process.argv[index + 1] ?? fallback).trim() : fallback;
}

const screenName = argument('--screen-name');
const postId = Number(argument('--post-id', '0'));
const apply = process.argv.includes('--apply');
const databasePath = argument('--database', 'data/bot.sqlite');

if (!screenName || !Number.isInteger(postId) || postId <= 0) {
    throw new Error('Usage: node scripts/repair-shared-multi-event-images.mjs --screen-name <name> --post-id <id> [--database <path>] [--apply]');
}

const database = new DatabaseSync(databasePath, { readOnly: !apply });
try {
    const source = database.prepare('SELECT image_urls_json, image_paths_json, image_vision_facts_json FROM vk_source_posts WHERE screen_name = ? AND post_id = ? LIMIT 1').get(screenName, postId);
    if (!source) throw new Error('Source post not found: ' + screenName + '/' + postId);
    const parseArray = (value) => {
        try { const parsed = JSON.parse(String(value ?? '[]')); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
    };
    const imageUrls = parseArray(source.image_urls_json).map(String).filter(Boolean);
    const imagePaths = parseArray(source.image_paths_json).map(String).filter(Boolean);
    const sourceFacts = parseArray(source.image_vision_facts_json);
    if (imageUrls.length !== 1 || imagePaths.length !== 1) throw new Error('Expected exactly one source image; got urls=' + imageUrls.length + ', paths=' + imagePaths.length);
    const events = database.prepare('SELECT id, event_index, title, poster_vision_facts_json FROM vk_events WHERE screen_name = ? AND post_id = ? AND is_multi_announcement = 1 ORDER BY event_index ASC, id ASC').all(screenName, postId);
    if (!events.length) throw new Error('No multi-announcement child events found');
    const sourceFact = sourceFacts.find((fact) => Number(fact?.index || 0) === 1) || { index: 1, imageType: 'source-image-fallback', visionStatus: 'not_run', visionInspected: false };
    const sharedFact = { ...sourceFact, index: 1, imagePath: imagePaths[0].replace(/\+/gu, '/'), fallbackBinding: 'multi-event-shared-source-image', sourceMediaBinding: true, sourceEventCount: events.length, sourceImageCount: 1 };
    const report = { screenName, postId, imagePath: imagePaths[0], childCount: events.length, mode: apply ? 'apply' : 'dry-run', children: events.map((event) => ({ id: event.id, eventIndex: event.event_index, title: event.title })) };
    if (apply) {
        database.exec('BEGIN IMMEDIATE');
        try {
            const update = database.prepare('UPDATE vk_events SET image_paths_json = ?, poster_match_status = ?, poster_match_reason = ?, poster_image_index = ?, poster_vision_facts_json = ? WHERE id = ?');
            for (const event of events) {
                const nextFacts = [...parseArray(event.poster_vision_facts_json).filter((fact) => Number(fact?.index || 0) !== 1), sharedFact];
                update.run(JSON.stringify([imagePaths[0]]), 'shared_multi_event_source_image', 'multi-event-shared-source-image', 1, JSON.stringify(nextFacts), event.id);
            }
            database.exec('COMMIT');
        } catch (error) { database.exec('ROLLBACK'); throw error; }
    }
    console.log(JSON.stringify(report, null, 2));
} finally { database.close(); }
