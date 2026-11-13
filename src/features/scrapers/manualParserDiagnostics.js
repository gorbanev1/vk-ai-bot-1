import {
    appendFileSync,
    existsSync,
    readdirSync,
    mkdirSync,
    renameSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { rm as rmAsync } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createParserPosterForensics } from './parserPosterForensics.js';
import { createVkDomFixtureCapture, readVkBrowserDom } from './vkDomFixtureCapture.js';
import { createVkFinalDomCapture } from './vkDomFinalSnapshot.js';
import { archiveParserErrorRun, recordParserError, refreshParserErrorEvidence, refreshParserErrorEvidenceAsync } from './parserErrorStore.js';

function safeSlug(value, fallback = 'source') {
    const normalized = String(value ?? '')
        .trim()
        .replace(/[^a-z0-9а-яё._-]+/giu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 100);
    return normalized || fallback;
}

export async function pruneParserForensicArchives({
    dataDirectory = './data',
    keepPerLabel = 3,
} = {}) {
    const root = resolve(dataDirectory, 'parser-forensic-archives');
    if (!existsSync(root)) return { removed: [], kept: 0 };
    const limit = Math.max(1, Math.trunc(Number(keepPerLabel) || 3));
    const groups = new Map();
    for (const name of readdirSync(root)) {
        const directory = resolve(root, name);
        if (directory === root || !directory.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`)) continue;
        let info;
        try { info = statSync(directory); } catch { continue; }
        if (!info.isDirectory()) continue;
        const parsed = name.match(/^\d{4}-\d{2}-\d{2}T[^_]+_(.+)_[0-9a-f]{6}$/u);
        if (!parsed) continue;
        const label = parsed[1];
        const rows = groups.get(label) || [];
        rows.push({ name, directory, mtimeMs: info.mtimeMs });
        groups.set(label, rows);
    }
    const removed = [];
    const deletions = [];
    for (const rows of groups.values()) {
        rows.sort((a, b) => b.name.localeCompare(a.name) || b.mtimeMs - a.mtimeMs);
        for (const [index, row] of rows.entries()) {
            if (index < limit) continue;
            // Recheck the resolved parent immediately before removal.
            if (resolve(row.directory, '..') !== root) continue;
            deletions.push(row);
        }
    }
    const concurrency = 8;
    for (let index = 0; index < deletions.length; index += concurrency) {
        const batch = deletions.slice(index, index + concurrency);
        const results = await Promise.allSettled(batch.map((row) => rmAsync(row.directory, { recursive: true, force: false, maxRetries: 3, retryDelay: 500 })));
        results.forEach((result, offset) => {
            if (result.status === 'fulfilled') removed.push(batch[offset].name);
            else if (result.reason?.code !== 'ENOENT') throw result.reason;
        });
    }
    return { removed, kept: [...groups.values()].reduce((sum, rows) => sum + rows.length, 0) - removed.length };
}

function safeJson(value) {
    const ancestors = [];
    return JSON.stringify(value, function (key, item) {
        if (/token|cookie|authorization|password|secret|api[_-]?key/iu.test(String(key))) {
            return '[REDACTED]';
        }
        if (item && typeof item === 'object') {
            while (ancestors.length && ancestors.at(-1) !== this) ancestors.pop();
            if (ancestors.includes(item)) return '[CIRCULAR]';
            ancestors.push(item);
        }
        if (typeof item === 'bigint') return String(item);
        if (item instanceof Error) {
            return {
                name: item.name,
                message: item.message,
                code: item.code,
                stack: item.stack,
            };
        }
        return item;
    });
}

export function createManualParserDiagnostics({
    dataDirectory = './data',
    label = 'manual-parser',
    onParserItemError = null,
} = {}) {
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    const suffix = randomBytes(3).toString('hex');
    const runId = `${stamp}_${safeSlug(label, 'manual-parser')}_${suffix}`;
    const directory = resolve(dataDirectory, 'parser-forensic-archives', runId);
    mkdirSync(directory, { recursive: true });
    try {
        void pruneParserForensicArchives({ dataDirectory, keepPerLabel: 3 }).then((pruned) => {
            if (pruned.removed.length) console.info('[PARSER ARCHIVE RETENTION]', `removed=${pruned.removed.length}`, 'limit=3', 'perLabel=true');
        }).catch((error) => {
            console.warn('[PARSER ARCHIVE RETENTION ERROR]', String(error?.message ?? error));
        });
    } catch (error) {
        console.warn('[PARSER ARCHIVE RETENTION ERROR]', String(error?.message ?? error));
    }
    const logPath = join(directory, 'trace.jsonl');
    writeFileSync(logPath, '', 'utf8');
    let sequence = 0;
    const sourceCounters = new Map();
    const artifacts = { domSnapshots: [], domStates: [], rawCaches: [], parserReports: [], textReports: [] };
    const posterForensics = createParserPosterForensics({ dataDirectory, runDirectory: directory });
    // parser-all-clean is also a final/raw-cache pass. Persisting every
    // intermediate DOM for it duplicates the already captured source and
    // makes recovery/audit archives much larger without changing processing
    // input. Keep the same one-final-DOM policy for all parser-all variants.
    const finalOnlyVk = /^parser-all(?:-secondary)?(?:-clean)?$/u.test(label);
    const finalParserSnapshots = new Map();
    const vkFinalDom = createVkFinalDomCapture({ runDirectory: directory, runId,
        onPersist: (record) => log('vk.final-fixture.persisted', record),
    });
    const vkDomFixtures = createVkDomFixtureCapture({ runDirectory: directory, runId,
        onPersist: (record) => log('vk.fixture.persisted', record),
    });
    artifacts.posterForensics = { directory: posterForensics.directory, logPath: posterForensics.logPath, imagesPath: posterForensics.imagesPath };
    artifacts.vkDomFixtures = { root: vkDomFixtures.root, baselineRoot: vkDomFixtures.baselineRoot, finalRoot: vkFinalDom.root,
        layout: finalOnlyVk ? 'parser-all: one final parser DOM; intermediate observations stay in memory'
            : 'legacy: one DOM per observed iteration and initial structure baseline' };
    function recordPosterPost(stage, data) {
        try { return posterForensics.recordPost(stage, data); }
        catch (error) {
            console.error('[PARSER POSTER FORENSICS WRITE ERROR]', stage, String(error?.code || ''), String(error?.message || error));
            log('poster-forensics.write-failed', { stage, error });
            return null;
        }
    }
    function recordFinalPosterSnapshot(snapshot, visibilityAudit) {
        try { return posterForensics.recordFinalSnapshot(snapshot, visibilityAudit); }
        catch (error) {
            console.error('[PARSER POSTER FINAL SNAPSHOT WRITE ERROR]', String(error?.code || ''), String(error?.message || error));
            log('poster-forensics.final-write-failed', { error });
            return null;
        }
    }

    function log(stage, data = null) {
        const record = {
            ts: new Date().toISOString(),
            seq: ++sequence,
            stage: String(stage || 'unknown'),
            data,
        };
        try {
            appendFileSync(logPath, `${safeJson(record)}\n`, 'utf8');
        } catch (error) {
            console.warn('[MANUAL PARSER TRACE WRITE ERROR]', String(error?.message ?? error));
        }
        return record;
    }

    async function captureDomSnapshot({ sourceId, page = null, html: providedHtml = null, label: snapshotLabel = 'snapshot', metadata = null } = {}) {
        // Existing parser contours still consume their in-memory snapshot. The
        // forensic command persists only one *final* raw VK DOM per source.
        if (finalOnlyVk && /^(?:vk:|chat:|tg:)/u.test(String(sourceId || ''))) return null;
        const hasProvidedHtml = typeof providedHtml === 'string';
        if (!hasProvidedHtml && (!page || typeof page.content !== 'function')) return null;
        const sourceSlug = safeSlug(sourceId, 'source');
        const counter = (sourceCounters.get(sourceSlug) || 0) + 1;
        sourceCounters.set(sourceSlug, counter);
        const suffixName = String(counter).padStart(3, '0');
        const fileName = `${sourceSlug}.${suffixName}.${safeSlug(snapshotLabel, 'snapshot')}.dom.html`;
        const path = join(directory, fileName);
        const startedAt = Date.now();
        try {
            const html = hasProvidedHtml ? providedHtml : await page.content();
            let pageUrl = '';
            try { pageUrl = String(page?.url?.() || ''); } catch {}
            const snapshotMetadata = {
                capturedAt: new Date().toISOString(),
                sourceId: String(sourceId || ''),
                url: String(metadata?.url || pageUrl || ''),
                ...(metadata && typeof metadata === 'object' ? metadata : {}),
            };
            // Intentionally save the COMPLETE DOM verbatim. The exact parser can
            // consume this very same string, so diagnostics are reproducible rather
            // than being a second page.content() taken a few seconds later.
            const body = String(html ?? '');
            writeFileSync(path, body, 'utf8');
            const sha256 = createHash('sha256').update(body, 'utf8').digest('hex');
            const bytes = Buffer.byteLength(body, 'utf8');

            let domState = null;
            if (page && typeof page.evaluate === 'function' && !page.isClosed?.()) {
                try {
                    domState = await page.evaluate(() => {
                        const attrs = (node) => Object.fromEntries(Array.from(node?.attributes || []).map((a) => [a.name, a.value]));
                        const rect = (node) => { const r = node?.getBoundingClientRect?.(); return r ? { x:r.x,y:r.y,width:r.width,height:r.height,top:r.top,left:r.left,right:r.right,bottom:r.bottom } : null; };
                        const visible = (node) => { try { const r=node.getBoundingClientRect(); const c=getComputedStyle(node); return r.width>0&&r.height>0&&c.display!=='none'&&c.visibility!=='hidden'&&Number(c.opacity||1)>0; } catch { return false; } };
                        const ownership = (node) => {
                            const post=node?.closest?.('[data-post-id], [data-testid="post"], [id^="post"], [id*="wall-"]');
                            const message=node?.closest?.('[data-itemkey], [data-cmid], [data-message-id], [data-msgid], .ConvoHistory__messageBlock');
                            const photo=node?.closest?.('a[href*="photo"], a[href*="z=photo"]');
                            const wall=node?.closest?.('a[href*="wall"]');
                            return { postId:post?.getAttribute?.('data-post-id')||post?.id||'', itemKey:message?.getAttribute?.('data-itemkey')||message?.getAttribute?.('data-cmid')||message?.getAttribute?.('data-message-id')||message?.getAttribute?.('data-msgid')||'', photoHref:photo?.href||photo?.getAttribute?.('href')||'', wallHref:wall?.href||wall?.getAttribute?.('href')||'' };
                        };
                        const imageRecord=(image,scope='document')=>({ scope, tagName:String(image?.tagName||'').toLowerCase(), currentSrc:String(image?.currentSrc||''), src:String(image?.getAttribute?.('src')||image?.src||''), srcset:String(image?.getAttribute?.('srcset')||image?.getAttribute?.('data-srcset')||''), dataSrc:String(image?.getAttribute?.('data-src')||''), naturalWidth:Number(image?.naturalWidth||0), naturalHeight:Number(image?.naturalHeight||0), clientWidth:Number(image?.clientWidth||0), clientHeight:Number(image?.clientHeight||0), rect:rect(image), visible:visible(image), attributes:attrs(image), ownership:ownership(image), outerHtml:String(image?.outerHTML||'') });
                        const images=Array.from(document.images).map((img)=>imageRecord(img));
                        const backgrounds=Array.from(document.querySelectorAll('[style*="background"], [class]')).flatMap((node)=>{ let value=''; try { value=getComputedStyle(node).backgroundImage||''; } catch {} if(!value||value==='none'||! /url\(/iu.test(value)) return []; return [{value,rect:rect(node),visible:visible(node),attributes:attrs(node),ownership:ownership(node),outerHtml:String(node.outerHTML||'').slice(0,12000)}]; });
                        const iframes=Array.from(document.querySelectorAll('iframe')).map((frame,index)=>{ const base={index,src:frame.src||frame.getAttribute('src')||'',attributes:attrs(frame),rect:rect(frame),visible:visible(frame)}; try { const doc=frame.contentDocument; return {...base,accessible:Boolean(doc),html:doc?.documentElement?.outerHTML||'',images:doc?Array.from(doc.images||[]).map((img)=>imageRecord(img,`iframe:${index}`)):[]}; } catch(error){ return {...base,accessible:false,error:String(error?.message||error)}; } });
                        const shadowRoots=[]; const queue=[document.documentElement]; const seen=new Set();
                        while(queue.length){ const node=queue.shift(); if(!node||seen.has(node)) continue; seen.add(node); if(node.shadowRoot){ const sr=node.shadowRoot; const idx=shadowRoots.length; shadowRoots.push({hostTag:String(node.tagName||'').toLowerCase(),hostId:node.id||'',hostClass:String(node.className||''),hostAttributes:attrs(node),html:String(sr.innerHTML||''),images:Array.from(sr.querySelectorAll('img')).map((img)=>imageRecord(img,`shadow:${idx}`))}); queue.push(...Array.from(sr.querySelectorAll('*'))); } queue.push(...Array.from(node.children||[])); }
                        return { capturedAt:new Date().toISOString(), href:location.href, title:document.title, visibilityState:document.visibilityState, scrollX:window.scrollX, scrollY:window.scrollY, innerWidth:window.innerWidth, innerHeight:window.innerHeight, devicePixelRatio:window.devicePixelRatio, images, backgrounds, iframes, shadowRoots };
                    });
                } catch (error) { domState = { captureError: String(error?.message ?? error) }; }
            }
            let statePath = '';
            let stateSha256 = '';
            if (domState) {
                statePath = path.replace(/\.dom\.html$/u, '.dom-state.json');
                const stateBody = `${safeJson({ htmlSha256: sha256, ...domState })}\n`;
                writeFileSync(statePath, stateBody, 'utf8');
                stateSha256 = createHash('sha256').update(stateBody, 'utf8').digest('hex');
                artifacts.domStates.push({ sourceId, label: snapshotLabel, path: statePath, sha256: stateSha256, htmlSha256: sha256 });
            }
            artifacts.domSnapshots.push({
                sourceId,
                label: snapshotLabel,
                path,
                chars: body.length,
                bytes,
                sha256,
                complete: true,
                metadata: snapshotMetadata,
                statePath,
                stateSha256,
            });
            // The full HTML is intentionally NOT truncated or embedded into the
            // JSONL line: it is written verbatim to `*.dom.html`; trace.jsonl
            // records the exact file, byte size and SHA-256 so a later forensic
            // pass can prove which complete DOM the parser actually saw.
            log('dom.snapshot.full', {
                sourceId,
                label: snapshotLabel,
                path,
                chars: body.length,
                bytes,
                sha256,
                complete: true,
                durationMs: Date.now() - startedAt,
                metadata: snapshotMetadata,
                statePath,
                stateSha256,
            });
            return path;
        } catch (error) {
            log('dom.snapshot.error', {
                sourceId,
                label: snapshotLabel,
                error,
                durationMs: Date.now() - startedAt,
            });
            return null;
        }
    }

    function cacheSource({ sourceId, kind = '', items = [], metadata = null } = {}) {
        const sourceSlug = safeSlug(sourceId, 'source');
        const path = join(directory, `${sourceSlug}.raw-cache.json`);
        const payload = {
            cachedAt: new Date().toISOString(),
            runId,
            sourceId,
            kind,
            itemCount: Array.isArray(items) ? items.length : 0,
            metadata,
            items: Array.isArray(items) ? items : [],
        };
        const json = safeJson(payload);
        const temporary = `${path}.tmp-${process.pid}`;
        writeFileSync(temporary, `${json}\n`, 'utf8');
        renameSync(temporary, path);
        // All configured VK/TG source capture rows, including items later rejected
        // by prefilter. Remote image URLs are logged; only already stored files can
        // be copied into the forensic images folder (no extra network requests).
        for (const [itemIndex, item] of payload.items.entries()) {
            recordPosterPost('source.raw-captured', {
                sourceId, itemId: String(item?.postId ?? item?.messageId ?? item?.id ?? itemIndex),
                post: item, kind, captureMetadata: metadata,
            });
        }
        artifacts.rawCaches.push({ sourceId, kind, path, itemCount: payload.itemCount, metadata });
        log('source.cache.saved', {
            sourceId,
            kind,
            path,
            itemCount: payload.itemCount,
            bytes: Buffer.byteLength(json, 'utf8'),
            metadata,
        });
        return path;
    }


    function saveParserReport({ sourceId, kind = '', report = null } = {}) {
        const sourceSlug = safeSlug(sourceId, 'source');
        const path = join(directory, `${sourceSlug}.parser-report.json`);
        const payload = {
            savedAt: new Date().toISOString(),
            sourceId,
            kind,
            report: report || {},
        };
        const json = safeJson(payload);
        writeFileSync(path, `${json}
`, 'utf8');
        artifacts.parserReports.push({ sourceId, kind, path });
        log('parser.report.saved', {
            sourceId,
            kind,
            path,
            bytes: Buffer.byteLength(json, 'utf8'),
        });
        return path;
    }

    function saveTextReport({ sourceId, kind = '', text = '' } = {}) {
        const sourceSlug = safeSlug(sourceId, 'source');
        const path = join(directory, `${sourceSlug}.audit.txt`);
        const body = String(text ?? '');
        writeFileSync(path, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
        artifacts.textReports.push({ sourceId, kind, path });
        log('text.report.saved', {
            sourceId,
            kind,
            path,
            bytes: Buffer.byteLength(body, 'utf8'),
        });
        return path;
    }

    function writeRunManifest(extra = null) {
        const path = join(directory, 'run-manifest.json');
        const payload = {
            runId,
            generatedAt: new Date().toISOString(),
            tracePath: logPath,
            artifacts,
            extra,
        };
        writeFileSync(path, `${safeJson(payload)}
`, 'utf8');
        return path;
    }

    log('run.start', { runId, directory, logPath, pid: process.pid });

    return {
        runId,
        directory,
        archiveRun(extra = {}) {
            return archiveParserErrorRun({ dataDirectory, runDirectory: directory, runId, extra });
        },
        logPath,
        relativeLogPath: `data/parser-forensic-archives/${runId}/trace.jsonl`,
        log,
        recordPosterPost,
        recordFinalPosterSnapshot,
        captureDomSnapshot,
        async captureVkDomFixture(args) {
            try {
                if (finalOnlyVk) {
                    // Intermediate HTML is consumed in memory to retain virtualized posts.
                    // The final parser input and its runtime state are captured atomically.
                    const snapshot = args.label === 'capture-complete'
                        ? await readVkBrowserDom(args.page, { includeStructure: true }) : null;
                    const html = snapshot?.html ?? await args.page.evaluate(() => document.documentElement.outerHTML);
                    if (!/^<html(?:\s|>)/iu.test(html || '')) throw new Error('VK in-memory DOM invalid');
                    if (snapshot) finalParserSnapshots.set(String(args.sourceId), snapshot);
                    return { html, persisted: false };
                }
                return await vkDomFixtures.capture(args);
            }
            catch (error) {
                log('vk.fixture.failed', { sourceId: args?.sourceId, label: args?.label, error });
                throw error;
            }
        },
        async captureVkStructureBaseline(args) {
            // parser-all intentionally keeps the final-DOM-only persistence
            // policy: intermediate baseline files are skipped there. The normal
            // public/chat finite passes use the baseline-derived selector
            // contract; parser-all exact extraction still consumes its immutable
            // final DOM and records the selected contract in parser diagnostics.
            try { if (finalOnlyVk) return { skipped: true, reason: 'final-dom-only-parser-all' };
                return await vkDomFixtures.captureStructureBaseline(args); }
            catch (error) {
                log('vk.structure-baseline.failed', { sourceId: args?.sourceId, error });
                throw error;
            }
        },
        async captureVkFinalDomSnapshot(args) {
            try {
                const key = String(args.sourceId);
                const snapshot = finalParserSnapshots.get(key);
                const result = await vkFinalDom.capture({ ...args, snapshot });
                finalParserSnapshots.delete(key);
                return result;
            }
            catch (error) { log('vk.final-fixture.failed', { sourceId: args?.sourceId, error }); throw error; }
        },
        finalDomOnly: finalOnlyVk,
        cacheSource,
        async onParserItemError({ sourceId = '', itemId = '', sourceKind = '', item = null, error = null, stage = 'processing', sourceLabel = '', sourceUrl = '', partyPool = 'primary' } = {}) {
            const rawCache = [...artifacts.rawCaches].reverse().find((entry) => entry.sourceId === sourceId);
            const domSnapshots = artifacts.domSnapshots.filter((entry) => entry.sourceId === sourceId);
            const domPath = domSnapshots.at(-1)?.path || '';
            const nativeDomPath = join(directory, 'vk-dom-final-snapshots');
            const rawCachePath = rawCache?.path || '';
            const record = recordParserError({
                dataDirectory, runDirectory: directory, runId, tracePath: logPath,
                sourceId, sourceLabel, sourceKind, partyPool, itemId, item, sourceUrl, stage, error,
                contentHash: String(item?.contentHash || item?.fingerprint || ''),
                details: {
                    rawCachePath, domPath: domPath || (existsSync(nativeDomPath) ? nativeDomPath : ''),
                    rawCacheRelativePath: rawCachePath ? relative(directory, rawCachePath) : '',
                    domRelativePath: domPath ? relative(directory, domPath) : '',
                    domPaths: domSnapshots.map((entry) => entry.path),
                    traceRelativePath: relative(directory, logPath),
                    runDirectory: directory,
                },
            });
            log('parser.item.error.persisted', { sourceId, itemId, stage, error, recordId: record.id, rawCachePath, domPath, domPaths: domSnapshots.map((entry) => entry.path) });
            archiveParserErrorRun({ dataDirectory, runDirectory: directory, runId });
            try {
                await onParserItemError?.(record);
            } catch (notificationError) {
                // Owner notifications are best effort; never convert an
                // already persisted parser error into an unhandled rejection.
                log('owner.error-notice.failed', { recordId: record.id, error: notificationError });
            }
            return record;
        },
        saveParserReport,
        saveTextReport,
        writeRunManifest,
        getArtifactsSummary() {
            return {
                domSnapshots: artifacts.domSnapshots.length,
                domStates: artifacts.domStates.length,
                rawCaches: artifacts.rawCaches.length,
                parserReports: artifacts.parserReports.length,
                textReports: artifacts.textReports.length,
                artifacts: {
                    domSnapshots: [...artifacts.domSnapshots],
                    domStates: [...artifacts.domStates],
                    rawCaches: [...artifacts.rawCaches],
                    parserReports: [...artifacts.parserReports],
                    textReports: [...artifacts.textReports],
                },
            };
        },
        async finishAsync(data = null) {
            const record = log('run.finish', data);
            const manifestPath = writeRunManifest({ finish: data });
            log('run.manifest.saved', { path: manifestPath });
            await refreshParserErrorEvidenceAsync({ dataDirectory, runDirectory: directory, runId });
            return record;
        },
        finish(data = null) {
            const record = log('run.finish', data);
            const manifestPath = writeRunManifest({ finish: data });
            log('run.manifest.saved', { path: manifestPath });
            refreshParserErrorEvidence({ dataDirectory, runDirectory: directory, runId });
            return record;
        },
    };
}
