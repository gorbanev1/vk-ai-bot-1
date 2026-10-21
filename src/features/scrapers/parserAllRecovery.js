import { readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';

const parserAll = (value) => /^parser-all(?:$|[:-])/u.test(String(value || ''));
const poolOf = (operation) => operation.metadata?.partyPool === 'secondary' ||
    operation.checkpoint?.partyPool === 'secondary' || /:secondary(?:$|:)/u.test(operation.name || '')
    ? 'secondary' : 'primary';

// Order by invocation, never savedAt: startup reconciliation rewrites savedAt
// on old checkpoints. A newer successful invocation supersedes every old failure.
export function loadLatestParserAllRecovery({
    directory = resolve('data/operation-checkpoints'),
    root = process.cwd(), partyPool = 'primary', expectedId = '',
} = {}) {
    let names;
    try { names = readdirSync(directory).filter((name) => name.endsWith('.json')); } catch { return null; }
    const rows = [];
    for (const name of names) {
        try {
            const path = join(directory, name);
            const payload = JSON.parse(readFileSync(path, 'utf8'));
            const operation = payload?.operation;
            if (!operation || (!parserAll(operation.name) && !parserAll(operation.checkpoint?.kind))) continue;
            if (poolOf(operation) !== partyPool) continue;
            rows.push({ path, payload, operation, stamp: Date.parse(operation.startedAt || '') || 0 });
        } catch { /* A damaged unrelated checkpoint must not break recovery. */ }
    }
    rows.sort((a, b) => b.stamp - a.stamp || b.path.localeCompare(a.path));
    const selected = rows[0];
    if (!selected) return null;
    const { operation, path } = selected;
    const checkpoint = operation.checkpoint || {};
    const phase = String(checkpoint.phase || operation.progress?.phase || 'unknown');
    const id = String(operation.id || '');
    const completed = (phase === 'completed' || (!checkpoint.phase && operation.status === 'completed')) && !Number(checkpoint.unfinishedCandidates || 0);
    if (expectedId && id !== expectedId) return { id, available: false, reason: 'superseded', partyPool };
    if (completed || checkpoint.recoveryDismissed || operation.status === 'superseded') return null;
    const cachePaths = new Map();
    const sourceIds = new Set(checkpoint.sourceIds || []);
    const traces = new Set();
    const addCache = (sourceId, cachePath) => {
        if (!sourceId) return;
        sourceIds.add(String(sourceId));
        if (cachePath) cachePaths.set(String(sourceId), resolve(root, String(cachePath)));
    };
    const consumeCheckpoint = (point, depth = 0) => {
        if (!point || depth > 4) return;
        consumeCheckpoint(point.previousCheckpoint, depth + 1);
        for (const trace of point.tracePaths || []) if (trace) traces.add(resolve(root, trace));
        for (const trace of [point.recoveryTracePath, point.tracePath]) if (trace) traces.add(resolve(root, trace));
        for (const row of Array.isArray(point.captures) ? point.captures : []) addCache(row.sourceId, row.cachePath);
    };
    consumeCheckpoint(checkpoint);
    if (operation.progress?.tracePath) traces.add(resolve(root, operation.progress.tracePath));
    for (const trace of traces) {
        let lines;
        try { lines = readFileSync(trace, 'utf8').split(/\r?\n/u); } catch { continue; }
        for (const line of lines) {
            try {
                const row = JSON.parse(line);
                if (row.stage === 'run.source-registry') {
                    for (const source of row.data?.sources || []) sourceIds.add(source.sourceId);
                }
                if (row.stage === 'source.cache.saved') addCache(row.data?.sourceId, row.data?.path);
            } catch { /* An incomplete JSONL tail does not invalidate earlier rows. */ }
        }
    }
    // A partial phase one must resume its original full capture generation.
    if (checkpoint.dateFreePhasePlan?.phaseOneComplete === false) {
        for (const row of checkpoint.dateFreePhasePlan.originalCaptures || []) addCache(row.sourceId, row.cachePath);
    }
    const cacheRows = new Map();
    const invalidCaches = [];
    const traceRunIds = new Set();
    for (const trace of traces) {
        let lines;
        try { lines = readFileSync(trace, 'utf8').split(/\r?\n/u); } catch { continue; }
        for (const line of lines) {
            try {
                const row = JSON.parse(line);
                if (row.stage === 'run.start' && row.data?.runId) traceRunIds.add(String(row.data.runId));
            } catch { /* incomplete trace tail */ }
        }
    }
    const recaptureSourceIds = new Set([...sourceIds].filter((sourceId) => !cachePaths.has(sourceId)));
    for (const [sourceId, cachePath] of cachePaths) {
        try {
            const payload = JSON.parse(readFileSync(cachePath, 'utf8'));
            if (!Array.isArray(payload.items) || (payload.sourceId && payload.sourceId !== sourceId)) throw new Error('invalid raw-cache/source identity');
            // A checkpoint may outlive several parser runs. Reusing a cache
            // from another run would silently mix capture generations, so a
            // cache with provenance must belong to the selected operation.
            if (payload.runId && (!traceRunIds.size || !traceRunIds.has(String(payload.runId)))) {
                // A cache carrying provenance is reusable only when the
                // selected checkpoint trace proves the same run. If the trace
                // is missing/truncated, accepting it would silently mix data
                // from an unrelated capture generation. Legacy caches without
                // runId remain supported below.
                throw new Error('raw-cache provenance mismatch or unavailable');
            }
            if (payload.items.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error('invalid raw-cache item');
            if (!payload.items.length && (payload.metadata?.captureError || payload.metadata?.stoppedByOwner)) {
                recaptureSourceIds.add(sourceId);
                continue;
            }
            cacheRows.set(sourceId, { path: cachePath, items: payload.items, itemCount: payload.items.length });
        } catch (error) {
            invalidCaches.push({ sourceId, path: cachePath, error: String(error.message) });
            recaptureSourceIds.add(sourceId);
        }
    }
    return {
        id, name: operation.name, partyPool, phase, path, checkpoint, status: operation.status,
        autoRecoveryDepth: Number(operation.metadata?.autoRecoveryDepth ?? checkpoint.autoRecoveryDepth ?? 0) || 0,
        startedAt: checkpoint.recoveryStartedAt || operation.startedAt,
        originalIncrementalOnly: checkpoint.recoveryIncrementalOnly ?? operation.metadata?.incrementalOnly ?? checkpoint.incrementalOnly ?? /parser-all-clean/u.test(operation.name || ''),
        tracePath: checkpoint.tracePath || operation.progress?.tracePath || checkpoint.recoveryTracePath || '',
        tracePaths: [...traces],
        cacheRows, sourceIds: [...sourceIds], invalidCaches,
        uncapturedSourceIds: [...recaptureSourceIds],
        available: cacheRows.size > 0,
        reason: cacheRows.size ? 'ready' : invalidCaches.length ? 'invalid-cache' : 'no-cache',
        noticePath: `${path}.recovery-notice`,
        posterGateImages: loadParserPosterGateImages([...traces]),
    };
}

// Carry only recovery inputs into the new operation, not old completion counters
// or dismissal/claim flags. Persist before any async work can be interrupted.
export function parserRecoveryCheckpointInputs(recovery, { ordinaryPhaseTwo = false } = {}) {
    if (!recovery) return {};
    const point = recovery.checkpoint || {};
    return {
        tracePaths: [...new Set([...(recovery.tracePaths || point.tracePaths || []), recovery.tracePath].filter(Boolean))],
        captures: [...(recovery.cacheRows || [])].map(([sourceId, row]) => ({ sourceId, cachePath: row.path })),
        sourceIds: recovery.sourceIds || [],
        recoveryStartedAt: recovery.startedAt,
        recoveryIncrementalOnly: recovery.originalIncrementalOnly,
        ...(point.dateFreePhasePlan ? { dateFreePhasePlan: point.dateFreePhasePlan } : {}),
        ...(point.phaseTwoModels ? { phaseTwoModels: point.phaseTwoModels } : {}),
        ordinaryPhaseTwo: ordinaryPhaseTwo === true || point.ordinaryPhaseTwo === true,
    };
}

// Preserve recovery inputs even when the caller only updates a stage/counter.
export function mergeParserAllCheckpoint(previous = {}, next = {}) {
    const merged = { ...previous, ...next };
    merged.tracePaths = [...new Set([...(previous.tracePaths || []), ...(next.tracePaths || []), previous.tracePath, next.tracePath].filter(Boolean))];
    if (!next.tracePath && previous.tracePath) merged.tracePath = previous.tracePath;
    if (previous.captures || next.captures) {
        const rows = new Map((previous.captures || []).map((row) => [row.sourceId, row]));
        for (const row of next.captures || []) {
            rows.set(row.sourceId, { ...rows.get(row.sourceId), ...row, cachePath: row.cachePath || rows.get(row.sourceId)?.cachePath || '' });
        }
        merged.captures = [...rows.values()];
    }
    return merged;
}

export function parserRecoveryCommand(partyPool = 'primary') {
    return partyPool === 'secondary' ? 'тусы второстепенные парсер все восстановить' : 'парсер все восстановить';
}

export function buildParserRecoveryNotice(recovery) {
    if (!recovery) return null;
    const command = parserRecoveryCommand(recovery.partyPool);
    const phasePaused = Boolean(recovery.checkpoint?.phaseTwoModels?.stopped && !recovery.checkpoint?.ordinaryPhaseTwo);
    const text = recovery.available ? [
        phasePaused ? '⚠️ Вторая фаза приостановлена по порогу отказов: Luna ≥85% или Terra ≥70%. Продолжить остаток по обычной лестнице или пропустить?' : '⚠️ Парсер остановился до полного завершения. Продолжить с сохранённого места?',
        `Запуск: ${recovery.id}; этап: ${recovery.phase}.`,
        `Сохранено источников: ${recovery.cacheRows.size}; элементов: ${[...recovery.cacheRows.values()].reduce((n, row) => n + row.itemCount, 0)}.`,
        'Текст, ссылки и изображения берутся из одной сохранённой записи. Успешно завершённые записи этого прохода повторно не обрабатываются.',
        recovery.uncapturedSourceIds.length ? `Источники без завершённого захвата будут собраны: ${recovery.uncapturedSourceIds.join(', ')}.` : '',
        recovery.invalidCaches?.length ? `Повреждённый кэш будет пересобран для: ${recovery.invalidCaches.map((row) => row.sourceId).join(', ')}.` : '',
        `Команда: «${command}».`,
    ] : [
        '⚠️ Парсер остановился до полного завершения.',
        `Запуск: ${recovery.id}; этап: ${recovery.phase}.`,
        recovery.reason === 'invalid-cache' ? `Кэш отсутствует или повреждён: ${recovery.invalidCaches.map((row) => row.sourceId).join(', ')}.` : 'Сохранённый кэш этого запуска не найден.',
        'Продолжение с прежнего места недоступно. Сохранённые карточки остаются в базе; нужен новый «парсер все».',
    ];
    return {
        text: text.filter(Boolean).join('\n'),
        replyMarkup: recovery.available ? { inline_keyboard: [[
            { text: phasePaused ? '▶️ Обычная лестница' : '▶️ Продолжить', callback_data: `parser_${phasePaused ? 'ladder' : 'resume'}:${recovery.id}` },
            { text: 'Оставить как есть', callback_data: `parser_keep:${recovery.id}` },
        ]] } : null,
    };
}

// A targeted, owner-authorized restart may resume this checkpoint only once.
// Later crashes still expose manual recovery, never an endless paid retry loop.
export function claimParserAllRecovery(recovery) {
    if (!recovery?.path || !recovery.id) return false;
    let payload;
    try { payload = JSON.parse(readFileSync(recovery.path, 'utf8')); }
    catch { return false; }
    const operation = payload?.operation;
    if (!operation || String(operation.id || '') !== String(recovery.id)) return false;
    const checkpoint = operation.checkpoint || {};
    if (checkpoint.recoveryDismissed || operation.status === 'superseded') return false;
    if (checkpoint.autoRecoveryClaimedAt) return false;
    const now = new Date().toISOString();
    operation.checkpoint = {
        ...checkpoint,
        autoRecoveryClaimedAt: now,
        autoRecoveryClaimedBy: `pid:${process.pid}`,
    };
    operation.updatedAt = now;
    payload.savedAt = now;
    const temporary = `${recovery.path}.tmp-${process.pid}-${Date.now()}`;
    try {
        writeFileSync(temporary, JSON.stringify(payload, null, 2) + '\n', 'utf8');
        renameSync(temporary, recovery.path);
        return true;
    } catch {
        try { unlinkSync(temporary); } catch {}
        return false;
    }
}

export function loadParserPosterGateImages(tracePaths = []) {
    const images = new Map();
    for (const path of tracePaths) {
        let lines;
        try { lines = readFileSync(path, 'utf8').split(/\r?\n/u); } catch { continue; }
        const batches = new Map();
        for (const line of lines) {
            let row;
            try { row = JSON.parse(line); } catch { continue; }
            const data = row.data || {};
            const key = `${data.sourceId || ''}\u0000${data.itemId || ''}`;
            if (row.stage === 'item.poster-gate.batch_start') batches.set(key, data);
            if (row.stage !== 'item.poster-gate.image') continue;
            const batch = batches.get(key);
            if (!batch || !data.imageUrl || !String(data.responseText || '').trim()) continue;
            const imageKey = `${key}\u0000${Number(data.imageNumber)}\u0000${data.imageUrl}`;
            images.set(imageKey, {
                responseText: data.responseText, sourceUrl: batch.sourceUrl || '',
                secondaryJointGate: Boolean(batch.secondaryJointGate),
                dateFreePhase: Boolean(batch.dateFreePhase),
                posterGatePolicyVersion: Number(batch.posterGatePolicyVersion || 1),
                semanticBodyText: batch.semanticBodyText || '',
            });
        }
    }
    return images;
}

export function getParserPosterGateImage(images, request, imageNumber, imageUrl) {
    const key = `${request.sourceId || ''}\u0000${request.itemId || ''}\u0000${imageNumber}\u0000${imageUrl}`;
    const saved = images?.get(key);
    if (!saved || saved.sourceUrl !== String(request.sourceUrl || '') ||
        saved.secondaryJointGate !== Boolean(request.secondaryJointGate)) return '';
    if (saved.dateFreePhase !== (request.visionPhase === 'phase2-date-free-image')) return '';
    // Old joint-gate negatives are not reusable under independent poster
    // admission. Successful metadata is still useful and remains cached.
    if (saved.dateFreePhase && Number(saved.posterGatePolicyVersion || 1) < 2 &&
        !/Это афиша события:\s*да/iu.test(saved.responseText)) return '';
    if ((saved.secondaryJointGate || saved.dateFreePhase) && saved.semanticBodyText !== String(request.sourceText || '')) return '';
    return saved.responseText;
}

export function dismissParserAllRecovery(recovery) {
    const payload = JSON.parse(readFileSync(recovery.path, 'utf8'));
    if (payload.operation.id !== recovery.id) throw new Error('Parser checkpoint changed');
    payload.operation.checkpoint = { ...payload.operation.checkpoint, recoveryDismissed: true };
    const temporary = `${recovery.path}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    renameSync(temporary, recovery.path);
}
