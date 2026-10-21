import { readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
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
    const cacheRows = new Map();
    const invalidCaches = [];
    const recaptureSourceIds = new Set([...sourceIds].filter((sourceId) => !cachePaths.has(sourceId)));
    for (const [sourceId, cachePath] of cachePaths) {
        try {
            const payload = JSON.parse(readFileSync(cachePath, 'utf8'));
            if (!Array.isArray(payload.items) || (payload.sourceId && payload.sourceId !== sourceId)) throw new Error('invalid raw-cache/source identity');
            if (payload.items.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error('invalid raw-cache item');
            if (!payload.items.length && (payload.metadata?.captureError || payload.metadata?.stoppedByOwner)) {
                recaptureSourceIds.add(sourceId);
                continue;
            }
            cacheRows.set(sourceId, { path: cachePath, items: payload.items, itemCount: payload.items.length });
        } catch (error) { invalidCaches.push({ sourceId, path: cachePath, error: String(error.message) }); }
    }
    return {
        id, name: operation.name, partyPool, phase, path, checkpoint, status: operation.status,
        startedAt: checkpoint.recoveryStartedAt || operation.startedAt,
        originalIncrementalOnly: checkpoint.recoveryIncrementalOnly ?? operation.metadata?.incrementalOnly ?? checkpoint.incrementalOnly ?? /parser-all-clean/u.test(operation.name || ''),
        tracePath: checkpoint.tracePath || operation.progress?.tracePath || checkpoint.recoveryTracePath || '',
        cacheRows, sourceIds: [...sourceIds], invalidCaches,
        uncapturedSourceIds: [...recaptureSourceIds],
        available: cacheRows.size > 0 && invalidCaches.length === 0,
        reason: invalidCaches.length ? 'invalid-cache' : cacheRows.size ? 'ready' : 'no-cache',
        noticePath: `${path}.recovery-notice`,
    };
}

// Preserve recovery inputs even when the caller only updates a stage/counter.
export function mergeParserAllCheckpoint(previous = {}, next = {}) {
    const merged = { ...previous, ...next };
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
    const text = recovery.available ? [
        '⚠️ Парсер остановился до полного завершения. Продолжить с сохранённого места?',
        `Запуск: ${recovery.id}; этап: ${recovery.phase}.`,
        `Сохранено источников: ${recovery.cacheRows.size}; элементов: ${[...recovery.cacheRows.values()].reduce((n, row) => n + row.itemCount, 0)}.`,
        'Текст, ссылки и изображения берутся из одной сохранённой записи. Успешно завершённые записи этого прохода повторно не обрабатываются.',
        recovery.uncapturedSourceIds.length ? `Источники без завершённого захвата будут собраны: ${recovery.uncapturedSourceIds.join(', ')}.` : '',
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
            { text: '▶️ Продолжить', callback_data: `parser_resume:${recovery.id}` },
            { text: 'Оставить как есть', callback_data: `parser_keep:${recovery.id}` },
        ]] } : null,
    };
}

export function dismissParserAllRecovery(recovery) {
    const payload = JSON.parse(readFileSync(recovery.path, 'utf8'));
    if (payload.operation.id !== recovery.id) throw new Error('Parser checkpoint changed');
    payload.operation.checkpoint = { ...payload.operation.checkpoint, recoveryDismissed: true };
    const temporary = `${recovery.path}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    renameSync(temporary, recovery.path);
}
