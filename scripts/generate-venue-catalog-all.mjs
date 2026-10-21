import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
const db = new DatabaseSync('data/bot.sqlite', { readOnly: true });
const specs = [['vk_events','vk'], ['vk_chat_events','vk_chat'], ['manual_events','manual'], ['telegram_events','telegram']];
const map = new Map();
for (const [table, source] of specs) {
  const rows = db.prepare(`SELECT venue,event_date AS eventDate,status,source_url AS sourceUrl FROM ${table} WHERE venue IS NOT NULL AND TRIM(venue)<>''`).all();
  for (const row of rows) {
    const venue = String(row.venue).trim();
    let item = map.get(venue);
    if (!item) { item = { venue, count: 0, firstDate: null, lastDate: null, sources: {} }; map.set(venue, item); }
    item.count++;
    if (row.eventDate) { const d = String(row.eventDate); if (!item.firstDate || d < item.firstDate) item.firstDate = d; if (!item.lastDate || d > item.lastDate) item.lastDate = d; }
    item.sources[source] = (item.sources[source] || 0) + 1;
  }
}
const venues = [...map.values()].sort((a,b) => a.venue.localeCompare(b.venue, 'ru'));
const out = { generatedAt: new Date().toISOString(), sourceTables: specs.map(x => x[0]), totalDistinctVenues: venues.length, totalRows: venues.reduce((n,x) => n + x.count, 0), venues };
writeFileSync('data/event-venue-catalog-all.json', JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ totalDistinctVenues: out.totalDistinctVenues, totalRows: out.totalRows }, null, 2));
