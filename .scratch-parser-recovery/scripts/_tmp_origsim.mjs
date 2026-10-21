import { DatabaseSync } from 'node:sqlite';
import { deduplicateEventsTwoContour } from '../src/features/events/eventDuplicateResolution.js';
const db = new DatabaseSync('data/bot.sqlite.audit-copy');
const rows = [
  ...db.prepare("SELECT id, 'vk' AS sourceType, title,event_date AS eventDate,event_time AS eventTime,venue,participants,price,description,source_url AS sourceUrl,image_paths_json FROM vk_events WHERE id IN (175,304)").all(),
  ...db.prepare("SELECT id, 'vk_chat' AS sourceType, title,event_date AS eventDate,event_time AS eventTime,venue,participants,price,description,source_url AS sourceUrl,image_paths_json FROM vk_chat_events WHERE id=70").all(),
].map((row) => ({ ...row, imagePaths: JSON.parse(row.image_paths_json || '[]') }));
const result = await deduplicateEventsTwoContour(rows, {
  arbitrateAmbiguous: async (pairs) => { console.log('pairs', pairs.map((p) => ({key:p.key,left:p.left.title,right:p.right.title}))); return new Map(pairs.map((pair) => [pair.key, { verdict: 'same', confidence: 1, reason: 'test' }])); },
});
console.log(JSON.stringify({ events: result.events.map((e) => ({id:e.id,title:e.title,lineage:e._dedupeLineage})), merges: result.merges.map((m) => ({left:m.leftTitle,right:m.rightTitle,contour:m.contour})), unresolved: result.unresolvedAmbiguous }, null, 2));
