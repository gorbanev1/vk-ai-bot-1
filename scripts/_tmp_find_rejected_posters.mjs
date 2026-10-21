import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = 'data/parser-forensic-archives';
const folders = readdirSync(root)
    .map((name) => join(root, name))
    .filter((path) => statSync(path).isDirectory() && /parser-all/u.test(path))
    .sort();

const rows = new Map();
for (const folder of folders) {
    const trace = join(folder, 'trace.jsonl');
    let lines;
    try { lines = readFileSync(trace, 'utf8').split(/\r?\n/u); } catch { continue; }
    for (const line of lines) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        const data = row.data || {};
        const sourceId = String(data.sourceId || '');
        const itemId = String(data.itemId ?? data.postId ?? data.messageId ?? '');
        if (!sourceId || !itemId) continue;
        const key = sourceId + ':' + itemId;
        const current = rows.get(key) || { key, sourceId, itemId, runs: [], visions: [], selections: [], mediaAudits: [], writes: [], failures: [] };
        if (!current.runs.includes(folder)) current.runs.push(folder);
        if (row.stage === 'item.ai.vision.response') current.visions.push(data);
        if (row.stage === 'item.ai.text.selection') current.selections.push(data);
        if (row.stage === 'item.ai.media.audit') current.mediaAudits.push(data);
        if (row.stage === 'item.ai.database.write') current.writes.push(data);
        if (row.stage === 'item.processing.fulfilled' && (data.result?.unresolved || data.error)) current.failures.push({ stage: row.stage, data });
        if (row.stage === 'item.processing.rejected' || row.stage === 'item.processing.failed') current.failures.push({ stage: row.stage, data });
        rows.set(key, current);
    }
}

const candidates = [];
for (const row of rows.values()) {
    const vision = row.visions.at(-1);
    const selection = row.selections.at(-1);
    const write = row.writes.at(-1);
    const posters = row.mediaAudits.flatMap((audit) => (audit.media || [])
        .filter((media) => media.vision?.poster === true || media.vision?.imageType === 'poster')
        .map((media) => ({
            imageIndex: media.imageIndex, url: media.url, localPath: media.localPath,
            title: media.vision?.title, dates: media.vision?.dates, time: media.vision?.time,
            venue: media.vision?.venue, city: media.vision?.city, address: media.vision?.address,
            participants: media.vision?.participants, reason: media.vision?.reason,
            confidence: media.vision?.posterConfidence, verdict: media.finalVerdict,
        })));
    const rejected = posters.filter((poster) => poster.verdict === 'poster-not-matched-to-event');
    const validationRejected = selection?.unresolved === true || selection?.reason === 'event-failed-validation' || Number(write?.effectiveEventCount || 0) === 0;
    if (!rejected.length && !validationRejected) continue;
    candidates.push({
        key: row.key, sourceId: row.sourceId, itemId: row.itemId, runs: row.runs,
        visionSummary: vision ? { responseText: vision.responseText, parsedFacts: vision.parsedFacts } : null,
        selection: selection ? { reason: selection.reason, unresolved: selection.unresolved, aiRawCount: selection.aiRawCount, aiValidatedCount: selection.aiValidatedCount } : null,
        write: write ? { effectiveEventCount: write.effectiveEventCount, acceptedEventCount: write.acceptedEventCount, storedEventCountBefore: write.storedEventCountBefore } : null,
        posters, rejected,
    });
}

console.log(JSON.stringify({ totalKeys: rows.size, candidateCount: candidates.length, candidates }, null, 2));
