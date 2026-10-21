const db = await import('../src/infrastructure/database/index.js');
const { normalizeEventDedupeRef } = await import('../src/app/botApplication.js');
const all = db.getAllUpcomingEventRecordsForDedupe({ fromDate: '2026-10-01', limitPerTable: 20000 });
const refs = db.getEventDedupeDuplicateRefs('configured');
const dup = new Set(refs.map((r) => `${r.sourceType}:${r.id}`));
const target = all.filter((e) => /origami|центр осени|манагер/iu.test(String(e.title || '')));
console.log('target', target.map((e) => ({ key: normalizeEventDedupeRef(e), title: e.title, sourceType: e.sourceType })));
console.log('registry duplicate refs', [...dup].filter((k) => /^(vk:175|vk:304|vk_chat:70|vk:339|vk_chat:65|vk:302|vk_chat:69)$/.test(k)));
console.log('visible target', target.filter((e) => !dup.has(`${normalizeEventDedupeRef(e)?.sourceType}:${normalizeEventDedupeRef(e)?.id}`)).map((e) => `${e.sourceType}:${e.id}:${e.title}`));
