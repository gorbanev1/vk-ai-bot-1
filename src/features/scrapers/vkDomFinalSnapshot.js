/** V188.141. Observe the NATIVE finite pass; never scroll for diagnostics. */
import fs from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { readVkBrowserDom } from './vkDomFixtureCapture.js';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const iso = () => new Date().toISOString();
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function atomicWrite(file, body) {
    const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    try {
        const handle = await fs.open(tmp, 'wx');
        try { await handle.writeFile(body); await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(tmp, file);
    } catch (error) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw error;
    }
}

/** A probe is lightweight: no outerHTML, parser, AI, navigation or page reload. */
export async function prepareVkFinalDomCapture({
    direction, readState, stepTowardsEdge, moveToEdge,
    maxSteps = 300, normalWaitMs = 1800, controlPasses = 2,
    controlWaitMs = 2500, finalSettleMs = 3000, maxControlRestarts = 6,
    pause = sleep,
} = {}) {
    if (!['up', 'down'].includes(direction) ||
        typeof readState !== 'function' || typeof stepTowardsEdge !== 'function' ||
        typeof moveToEdge !== 'function') {
        throw new Error('Final VK DOM: expected direction up/down and source-native scroll callbacks');
    }
    const progress = [];
    let state = await readState();
    const atEdge = (current) => direction === 'down' ? current?.atBottom : current?.atTop;
    const record = (phase, detail = {}) => progress.push({
        phase, direction, at: iso(), ...detail, state: state || null,
    });
    record('start');
    let steps = 0;
    while (!atEdge(state) && steps < maxSteps) {
        const move = await stepTowardsEdge();
        await pause(normalWaitMs);
        state = await readState();
        steps += 1;
        record('main', { step: steps, move: move || null });
    }
    let controlRestarts = 0;
    let controlsCompleted = 0;
    // A control may cause new pagination and move the true edge. We must go
    // towards that new edge again, without comparing or saving full HTML.
    while (atEdge(state) && controlsCompleted < controlPasses && controlRestarts <= maxControlRestarts) {
        const heightBefore = Number(state?.scrollHeight || 0);
        const move = await moveToEdge();
        await pause(controlWaitMs);
        state = await readState();
        record('control', { controlNumber: controlsCompleted + 1,
            heightBefore, move: move || null });
        if (!atEdge(state) || Number(state?.scrollHeight || 0) > heightBefore) {
            controlsCompleted = 0;
            controlRestarts += 1;
            record('reactivated', { controlRestarts });
            while (!atEdge(state) && steps < maxSteps) {
                const nextMove = await stepTowardsEdge();
                await pause(normalWaitMs);
                state = await readState();
                steps += 1;
                record('main-after-reactivation', { step: steps, move: nextMove || null });
            }
        } else {
            controlsCompleted += 1;
        }
    }
    await pause(finalSettleMs);
    state = await readState();
    record('ready-for-capture', { steps, controlsCompleted, controlRestarts });
    const prepared = Boolean(atEdge(state) && controlsCompleted >= controlPasses &&
        controlRestarts <= maxControlRestarts);
    return { direction, prepared, status: prepared ? 'edge-confirmed-bounded' : 'bounded-or-unstable',
        maxSteps, steps, controlPasses, controlsCompleted, controlRestarts,
        maxControlRestarts, normalWaitMs, controlWaitMs, finalSettleMs, finalState: state,
        completedAt: iso(), progress,
        // A page can virtualize older nodes. A successful edge probe is NOT a
        // guarantee of entire feed/history coverage.
        completenessClaim: 'DOM present in the browser at one capture instant; not the entire source history',
    };
}

/** Exactly ONE raw DOM read for the final fixture; the manifest is written last. */
export function createVkFinalDomCapture({ runDirectory, runId, onPersist = null } = {}) {
    const root = join(runDirectory, 'vk-dom-final-snapshots');
    const saved = new Map();
    const checkpoints = new Map();
    const checkpointIntervalMs = 10_000;
    const checkpointGrowthRatio = 1.30;
    const maxCheckpointsPerSource = 12;
    function sourceDirectory(key) {
        const token = hash(Buffer.from(key)).slice(0, 16);
        const slug = key.replace(/[^a-z0-9_-]+/giu, '-').slice(0, 50) || 'vk';
        return join(root, `${slug}-${token}`);
    }
    /** Use HTML ALREADY READ by the scraper. No page.evaluate, extra scrolling or timer. */
    async function observe({ sourceId, html, label = 'native-observation', metadata = null } = {}) {
        if (!sourceId || typeof html !== 'string' || !/^<html(?:\s|>)/iu.test(html)) {
            throw new Error('VK DOM checkpoint: invalid sourceId or raw HTML');
        }
        const key = String(sourceId);
        if (saved.has(key)) return { skipped: true, reason: 'final-already-captured' };
        const bytes = Buffer.from(html, 'utf8');
        const htmlSha256 = hash(bytes);
        const now = Date.now();
        const record = checkpoints.get(key) || { items: [], lastAt: 0, lastBytes: 0, lastSha256: '' };
        if (htmlSha256 === record.lastSha256) return { skipped: true, reason: 'unchanged' };
        if (record.items.length >= maxCheckpointsPerSource) return { skipped: true, reason: 'checkpoint-limit' };
        const elapsedMs = now - record.lastAt;
        const growth = record.lastBytes > 0 && bytes.byteLength >= record.lastBytes * checkpointGrowthRatio;
        if (record.items.length > 0 && elapsedMs < checkpointIntervalMs && !growth) {
            return { skipped: true, reason: 'throttled' };
        }
        const directory = sourceDirectory(key);
        const number = record.items.length + 1;
        const file = `checkpoints/${String(number).padStart(3, '0')}.dom.raw.html`;
        await fs.mkdir(join(directory, 'checkpoints'), { recursive: true });
        await atomicWrite(join(directory, file), bytes);
        // During an unfinished pass this is the latest intact observed HTML.
        // Never append HTML fragments: that would corrupt its DOM structure.
        await atomicWrite(join(directory, 'latest.dom.raw.html'), bytes);
        const item = { number, label, file, at: iso(), htmlBytes: bytes.byteLength,
            htmlSha256, reason: number === 1 ? 'initial-observation' : growth ? 'growth-30-percent' : 'elapsed-10-seconds',
            metadata };
        record.items.push(item);
        record.lastAt = now;
        record.lastBytes = bytes.byteLength;
        record.lastSha256 = htmlSha256;
        checkpoints.set(key, record);
        // A checkpoint is immutable; only this small index is updated.
        await atomicWrite(join(directory, 'checkpoints', 'index.json'), json({
            schemaVersion: 1, sourceId: key, finalSnapshotIsCanonical: true,
            intervalMs: checkpointIntervalMs, growthRatio: checkpointGrowthRatio,
            maxCheckpoints: maxCheckpointsPerSource, checkpoints: record.items,
        }));
        return { saved: true, sourceId: key, directory, ...item };
    }
    async function capture({ page, sourceId, direction, sourceKind, preparation }) {
        if (!sourceId || !['up', 'down'].includes(direction)) {
            throw new Error('Final VK DOM: sourceId and pagination direction required');
        }
        const key = String(sourceId);
        if (saved.has(key)) return saved.get(key);
        const work = (async () => {
            if (page?.isClosed?.()) throw new Error('Final VK DOM: source page was closed');
            const snapshot = await readVkBrowserDom(page, { includeStructure: true });
            if (!/^<html(?:\s|>)/iu.test(snapshot.html || '')) {
                throw new Error('Final VK DOM: invalid raw documentElement.outerHTML');
            }
            const dir = sourceDirectory(key);
            await fs.mkdir(dir, { recursive: true });
            const html = Buffer.from(snapshot.html, 'utf8');
            const htmlSha256 = hash(html);
            const checkpointItems = checkpoints.get(key)?.items || [];
            const metadata = { schemaVersion: 1, kind: 'one-final-dom-after-pagination',
                runId, sourceId: key, sourceKind, paginationDirection: direction,
                capturedAt: snapshot.capturedAt, htmlBytes: html.byteLength, htmlSha256,
                state: snapshot.state, preparation, parserResultIncluded: false,
                expectedAnnouncementsVerified: false, allHistoryGuaranteed: false,
                checkpointCount: checkpointItems.length,
                capturePolicy: 'native-scroll-only; intermediate checkpoints from in-memory parser HTML; final DOM is authoritative' };
            await atomicWrite(join(dir, 'dom.raw.html'), html);
            await atomicWrite(join(dir, 'latest.dom.raw.html'), html);
            await atomicWrite(join(dir, 'page-state.json'), json(metadata));
            await atomicWrite(join(dir, 'dom.structure.json'), json({ ...snapshot.structure,
                canonicalInput: 'dom.raw.html', rawDomSha256: htmlSha256, sourceId: key }));
            await atomicWrite(join(dir, 'resources.json'), json({ htmlSha256,
                resources: snapshot.resources || [] }));
            await atomicWrite(join(dir, 'pagination-progress.json'), json(preparation));
            await atomicWrite(join(dir, 'PROMPT_FOR_DOM_AUDIT_RU.txt'),
                'Используй dom.raw.html как неизменяемый первичный вход для точного офлайн DOM-парсера.\n' +
                'page-state.json, dom.structure.json и resources.json — независимый контекст, не результаты парсинга.\n' +
                'Найди реальные повторяющиеся карточки; для полей ID/текст/дата/ссылка/картинка\n' +
                'покажи точные DOM-узлы, атрибуты, примеры и признаки отсутствующего поля.\n' +
                'Не выдумывай эталонные анонсы по старому парсеру. Слепок не гарантирует всю ленту,\n' +
                'особенно если VK использует виртуализацию или pagination остановилась по лимиту.\n');
            await atomicWrite(join(dir, 'manifest.json'), json({ schemaVersion: 1,
                kind: metadata.kind, status: 'complete', runId, sourceId: key,
                sourceKind, paginationDirection: direction, capturedAt: snapshot.capturedAt,
                htmlBytes: html.byteLength, htmlSha256,
                preparationStatus: preparation?.status || 'unknown',
                fullDomSnapshotsDuringPagination: checkpointItems.length, finalFullDomSnapshots: 1,
                checkpoints: checkpointItems.map(({ number, file, htmlBytes, htmlSha256 }) =>
                    ({ number, file, htmlBytes, htmlSha256 })),
                files: ['dom.raw.html', 'latest.dom.raw.html', 'page-state.json', 'dom.structure.json',
                    'resources.json', 'pagination-progress.json', 'PROMPT_FOR_DOM_AUDIT_RU.txt'] }));
            const result = { sourceId: key, directory: dir, htmlBytes: html.byteLength,
                htmlSha256, preparationStatus: preparation?.status || 'unknown',
                direction, capturedAt: snapshot.capturedAt };
            onPersist?.(result);
            return result;
        })();
        saved.set(key, work);
        try { return await work; }
        catch (error) { if (saved.get(key) === work) saved.delete(key); throw error; }
    }
    return { root, observe, capture };
}
