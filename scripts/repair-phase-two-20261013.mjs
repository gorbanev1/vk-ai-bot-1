import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { extractCapturedPosterEventsForRepair, rebuildVerifiedPartySnapshotQueued } from '../src/app/botApplication.js';
import { getAllUpcomingEventRecordsForDedupe, updateStoredEventRecordFromReparse, replaceVkEventsForPost, replaceTelegramEventsForPost, finalizeManualParserSeenItem } from '../src/infrastructure/database/index.js';
import { parseIndexedImageFacts, serializeIndexedImageFacts, assignEventImageIndexesFromFacts } from '../src/features/events/eventPosterMatching.js';
import { extractExplicitDates } from '../src/features/events/publicPostDateEvidence.js';

const sqlite = new DatabaseSync('data/bot.sqlite');
const reportDir = 'data/phase-two-repair-20261013';
mkdirSync(reportDir, { recursive: true });
const report = { startedAt: new Date().toISOString(), updated: [], sources: [], errors: [] };
const save = () => writeFileSync(join(reportDir, 'report.json'), JSON.stringify(report, null, 2));
const beforeSnapshot = readFileSync('data/event-verified-snapshot.json');
writeFileSync(join(reportDir, 'snapshot-before.json'), beforeSnapshot);
const today = '2026-10-13';
const current = getAllUpcomingEventRecordsForDedupe({ fromDate: today });

// Repair the four rows omitted from the last verified listing, plus the same
// malformed monthly source's already-visible row. Keep their original IDs.
const repairs = current.filter(e => (e.sourceType === 'vk' && [530,531,532,533].includes(e.id)) || (e.sourceType === 'telegram' && e.id === 124));
for (const event of repairs) {
    try {
        const type = event.sourceType, key = type === 'vk' ? 'screen_name' : 'channel', item = type === 'vk' ? 'post_id' : 'message_id';
        const source = sqlite.prepare(`SELECT * FROM ${type}_source_posts WHERE ${key}=? AND ${item}=?`).get(event.screenName || event.channel, event.postId || event.messageId);
        const localImagePath = join('data', event.imagePaths[0]);
        const cache = join(reportDir, `${type}-${event.postId || event.messageId}.json`);
        let extracted;
        try { extracted = JSON.parse(readFileSync(cache)); } catch {
            extracted = await extractCapturedPosterEventsForRepair({ text: source.raw_text, publishedAt: source.published_at, sourceUrl: event.sourceUrl }, { localImagePath });
            writeFileSync(cache, JSON.stringify(extracted, null, 2));
        }
        const matching = extracted.events.find(e=>e.eventDate === event.eventDate);
        if (!matching) throw new Error(`No event on ${event.eventDate}: ${extracted.structure}: ${extracted.reason}`);
        const [bound] = assignEventImageIndexesFromFacts([matching], extracted.facts, { dateFreePhase: true });
        const updated = { ...event, ...bound, imagePaths: [event.imagePaths[0]],
            posterVisionFacts: bound.posterVisionFacts.map(f=>({ ...f, imagePath: event.imagePaths[0] })),
            description: source.raw_text, sourceUrl: event.sourceUrl, status: 'approved' };
        writeFileSync(join(reportDir, `${type}-${event.id}-before.json`), JSON.stringify(event, null, 2));
        updateStoredEventRecordFromReparse({ sourceType: type, id: event.id, event: updated });
        report.updated.push({ sourceType: type, id: event.id, title: updated.title, date: updated.eventDate }); save();
    } catch(error) { report.errors.push({ id:event.id, type:event.sourceType, error: String(error?.message || error) }); save(); }
}

// Only the failed pass's sources with a real confirmed future poster and no
// card are recovered. Past posters and undated material are reported, never
// assigned the date of publication.
for (const type of ['vk', 'telegram']) {
    const key = type === 'vk' ? 'screen_name' : 'channel', item = type === 'vk' ? 'post_id' : 'message_id';
    const rows = sqlite.prepare(`SELECT p.* FROM ${type}_source_posts p WHERE p.fetched_at>=1791880000 AND NOT EXISTS (SELECT 1 FROM ${type}_events e WHERE e.${key}=p.${key} AND e.${item}=p.${item})`).all();
    for (const row of rows) {
        const original = JSON.parse(row.image_vision_facts_json);
        const facts = serializeIndexedImageFacts(original);
        const positive = original.filter(f=>f.poster === true);
        if (!positive.length) continue;
        const future = positive.some(f=>extractExplicitDates(f.text, row.published_at).some(d=>d>=today));
        if (!future) { report.sources.push({type,source:row[key],item:row[item],result:'no-confirmed-future-date'}); continue; }
        try {
            const extracted = await extractCapturedPosterEventsForRepair({ text: row.raw_text, publishedAt: row.published_at, sourceUrl: row.source_url, __posterGateFacts: facts });
            const paths = JSON.parse(row.image_paths_json);
            const events = assignEventImageIndexesFromFacts(extracted.events.filter(e=>e.eventDate>=today), facts, {dateFreePhase:true})
                .map(e=>({ ...e, imagePaths: [paths[e.posterImageIndex-1]].filter(Boolean), posterVisionFacts:e.posterVisionFacts.map(f=>({...f,imagePath:paths[f.index-1]})) }));
            if (!events.length) throw new Error(`No dated complete events: ${extracted.structure}: ${extracted.reason}`);
            const sourceId = `${type==='vk'?'vk':'tg'}:${row[key]}`;
            if (type==='vk') replaceVkEventsForPost({screenName:row[key],postId:row[item],sourceUrl:row.source_url,imagePaths:paths,events});
            else replaceTelegramEventsForPost({channel:row[key],messageId:row[item],sourceUrl:row.source_url,imagePaths:paths,events});
            finalizeManualParserSeenItem({sourceId,itemId:String(row[item]),parseStatus:'processed_event'});
            report.sources.push({type,source:row[key],item:row[item],result:'recovered',events:events.map(e=>({title:e.title,date:e.eventDate}))}); save();
        } catch(error) { report.errors.push({type,source:row[key],item:row[item],error:String(error?.message||error)}); save(); }
    }
}
save();
report.snapshot = await rebuildVerifiedPartySnapshotQueued({reason:'parser-all-phase2-owner-repair-20261013'});
report.finishedAt = new Date().toISOString(); save();
console.log(JSON.stringify({updated:report.updated,sources:report.sources,errors:report.errors,snapshot:report.snapshot},null,2));
sqlite.close();
process.exit(report.errors.length ? 2 : 0);
