import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { loadParserPosterGateImages } from './parserAllRecovery.js';

// Runs in the parser worker: large raw caches and traces must not block replies.
export function loadParserReplayEvidence({ rows = [], replayAll = false, discoverArchives = false, dataDirectory = './data' } = {}) {
    if (discoverArchives) rows = [...rows, ...discoverParserEvidence(rows, dataDirectory)];
    const wanted = new Set(rows.map(row => String(row.itemId || '')).filter(Boolean));
    const itemsById = new Map(), imageCache = new Map(), cacheErrors = [];
    const cachePaths = new Set(), directories = new Set(), traces = new Set();
    const addItem = item => {
        const id = String(item?.postId ?? item?.conversationMessageId ?? item?.messageId ?? item?.id ?? '');
        if (id && (replayAll || wanted.has(id)) && !itemsById.has(id)) itemsById.set(id, item);
    };
    const evidence = rows.flatMap(row => [
        row, ...(row.evidenceHistory || []).slice().reverse(),
        { archiveDirectory: row.originalArchiveDirectory },
    ]);
    for (const entry of evidence) {
        if (entry.rawCachePath) cachePaths.add(entry.rawCachePath);
        if (entry.archiveDirectory) directories.add(entry.archiveDirectory);
        if (entry.tracePath) traces.add(entry.tracePath);
    }
    for (const path of cachePaths) {
        try {
            const payload = JSON.parse(readFileSync(path, 'utf8'));
            for (const item of Array.isArray(payload.items) ? payload.items : []) addItem(item);
        } catch (error) { cacheErrors.push({ cachePath: path, error: error.message }); }
    }
    for (const row of rows) if (row.item) addItem(row.item);
    const urls = new Set([...itemsById.values()].flatMap(item => Array.isArray(item.imageUrls) ? item.imageUrls : []));
    for (const directory of directories) {
        const path = join(directory, 'raw-images', 'manifest.json');
        let manifest;
        try { manifest = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
        if (!Array.isArray(manifest)) continue;
        for (const entry of manifest) {
            if (!Array.isArray(entry)) continue;
            const [url, image] = entry;
            if (!urls.has(url) || imageCache.has(url) || !image?.path) continue;
            // Archives retain the original path, but the original run may be pruned.
            for (const candidate of [image.path, join(dirname(path), basename(image.path))]) {
                try {
                    const stat = statSync(candidate);
                    if (!stat.isFile() || !stat.size || (image.byteLength && stat.size !== image.byteLength)) continue;
                    imageCache.set(url, { ...image, path: candidate });
                    break;
                } catch {}
            }
        }
    }
    const posterGateImages = loadParserPosterGateImages([...traces].reverse());
    const sourceIds = new Set(rows.map(row => row.sourceId));
    for (const key of posterGateImages.keys()) {
        const [source, id] = key.split('\0');
        if (!sourceIds.has(source) || (!replayAll && !wanted.has(id))) posterGateImages.delete(key);
    }
    return { itemsById, imageCache, posterGateImages, cacheErrors };
}


// Missing-poster records can be newer than their original successful capture.
// Find exact source/item evidence even when no error was recorded for that run.
function discoverParserEvidence(rows, root) {
 const result=[];
 for(const sourceId of new Set(rows.map(row=>row.sourceId))) {
  if(!/^(?:vk|tg|chat):[a-z0-9_-]+$/i.test(sourceId||''))continue;
  const wanted=new Set(rows.filter(row=>row.sourceId===sourceId).map(row=>String(row.itemId||'')));
  const filename=sourceId.replace(':','-')+'.raw-cache.json';
  const directories=[];
  for(const base of ['parser-forensic-archives','parser-error-archives']) {
   const parent=join(root,base);
   try{for(const name of readdirSync(parent))if(/^\d{4}-/.test(name))directories.push(join(parent,name));}catch{}
  }
  directories.sort((a,b)=>basename(b).localeCompare(basename(a)));
  for(const directory of directories) {
   if(!wanted.size)break;
   const path=join(directory,filename);if(!existsSync(path))continue;
   let payload;try{payload=JSON.parse(readFileSync(path,'utf8'));}catch{continue;}
   for(const item of payload.items||[]) {
    const id=String(item.postId??item.messageId??item.conversationMessageId??'');
    if(!wanted.has(id)||!item.imageUrls?.length)continue;
    result.push({sourceId,itemId:id,archiveDirectory:directory,rawCachePath:path,tracePath:join(directory,'trace.jsonl')});
    wanted.delete(id);
   }
  }
 }
 return result;
}
