import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { extractExplicitDates } from '../src/features/events/publicPostDateEvidence.js';
const db = new DatabaseSync('data/bot.sqlite', { readOnly: true });
const today = '2026-10-13';
const parse = value => { try { return JSON.parse(value || '[]'); } catch { return []; } };
const report = { sources: [], ignored: [], schemas: {}, active: [] };
for (const [type, table, key, item] of [
    ['vk', 'vk_source_posts', 'screen_name', 'post_id'],
    ['telegram', 'telegram_source_posts', 'channel', 'message_id'],
    ['vk_chat', 'vk_chat_source_messages', 'peer_id', 'conversation_message_id'],
]) {
    report.schemas[table] = db.prepare(`PRAGMA table_info(${table})`).all().map(x => x.name);
    for (const row of db.prepare(`SELECT * FROM ${table}`).all()) {
        const facts = parse(row.image_vision_facts_json).filter(f => f.poster === true);
        const dates = [...new Set(facts.flatMap(f => extractExplicitDates([f.dates, f.recognizedText, f.text].filter(Boolean).join('\n'), row.published_at)).filter(d => d >= today))];
        if (!dates.length) continue;
        const events = db.prepare(`SELECT id,title,event_date,status FROM ${type}_events WHERE ${key}=? AND ${item}=?`).all(row[key], row[item]);
        report.sources.push({ type, source: row[key], item: row[item], dates, events, missingDates: dates.filter(d => !events.some(e => e.event_date === d)), url: row.source_url, publishedAt: row.published_at, text: row.raw_text, paths: parse(row.image_paths_json), facts });
    }
    report.ignored.push(...db.prepare(`SELECT id,title,event_date,status FROM ${type}_events WHERE status='ignored' AND event_date>=?`).all(today).map(e => ({type,...e})));
}
report.schemas.ledger=db.prepare('PRAGMA table_info(manual_parser_seen_items)').all().map(x=>x.name);
report.blocks=db.prepare('SELECT * FROM event_permanent_blocks WHERE active=1').all();
report.archives=db.prepare('SELECT source_type,event_id,canonical_source_type,canonical_event_id,event_row_json FROM event_dedupe_archive').all().filter(r=>parse(r.event_row_json).event_date>=today);
for(const file of fs.readdirSync('data/operation-checkpoints')) {
    if(!file.endsWith('.json'))continue;
    const op=parse(fs.readFileSync('data/operation-checkpoints/'+file,'utf8')).operation;
    if(op && /parser|dedup/.test(op.name||'') && ['running','stopping'].includes(op.status)) report.active.push({id:op.id,name:op.name,status:op.status,updatedAt:op.updatedAt});
}
fs.writeFileSync('.scratch-confirmed-posters-20261013.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({active:report.active,ignored:report.ignored,sources:report.sources.length,gaps:report.sources.filter(s=>s.missingDates.length).map(s=>({type:s.type,source:s.source,item:s.item,dates:s.dates,existing:s.events,posters:s.facts.map(f=>({title:f.title,dates:f.dates,venue:f.venue}))}))},null,2));
