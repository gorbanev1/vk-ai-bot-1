import {
    existsSync,
    readdirSync,
    readFileSync,
    statSync,
} from 'node:fs';
import { resolve } from 'node:path';

const requested = String(process.argv[2] || process.env.AI_TOKEN_USAGE_LOG_DIR || './data/ai-token-usage').trim();
const target = resolve(requested || './data/ai-token-usage');

function collectFiles(path) {
    if (!existsSync(path)) return [];
    if (statSync(path).isFile()) return [path];
    return readdirSync(path)
        .filter((name) => name.endsWith('.jsonl'))
        .sort()
        .map((name) => resolve(path, name));
}

function num(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

const files = collectFiles(target);
if (!files.length) {
    console.log(`[AI TOKEN REPORT] no JSONL logs found: ${target}`);
    process.exit(0);
}

const totals = new Map();
let badLines = 0;
let rows = 0;
for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/u)) {
        if (!line.trim()) continue;
        let row;
        try {
            row = JSON.parse(line);
        } catch {
            badLines += 1;
            continue;
        }
        rows += 1;
        const operation = String(row.operation || 'unclassified');
        const provider = String(row.provider || 'unknown');
        const model = String(row.model || 'unknown');
        const key = `${operation}\u0000${provider}\u0000${model}`;
        const previous = totals.get(key) || {
            operation,
            provider,
            model,
            requests: 0,
            exactRequests: 0,
            estimatedRequests: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            cachedTokens: 0,
            reasoningTokens: 0,
            estimatedTextTokens: 0,
            durationMs: 0,
        };
        previous.requests += 1;
        if (row.usageSource === 'provider') previous.exactRequests += 1;
        if (row.usageSource === 'estimated') previous.estimatedRequests += 1;
        previous.inputTokens += num(row.inputTokens);
        previous.outputTokens += num(row.outputTokens);
        previous.totalTokens += num(row.totalTokens);
        previous.cachedTokens += num(row.cachedTokens);
        previous.reasoningTokens += num(row.reasoningTokens);
        previous.estimatedTextTokens += num(row.estimatedTextTokens);
        previous.durationMs += num(row.durationMs);
        totals.set(key, previous);
    }
}

const report = [...totals.values()].sort((left, right) => {
    const leftComparable = left.totalTokens + left.estimatedTextTokens;
    const rightComparable = right.totalTokens + right.estimatedTextTokens;
    return rightComparable - leftComparable || right.requests - left.requests || left.operation.localeCompare(right.operation);
});

console.log(`[AI TOKEN REPORT] files=${files.length} rows=${rows} badLines=${badLines}`);
console.log([
    'operation',
    'provider',
    'model',
    'requests',
    'exactReq',
    'estimatedReq',
    'input',
    'output',
    'exactTotal',
    'estimatedText',
    'cached',
    'reasoning',
    'durationMs',
].join('\t'));
for (const row of report) {
    console.log([
        row.operation,
        row.provider,
        row.model,
        row.requests,
        row.exactRequests,
        row.estimatedRequests,
        row.inputTokens,
        row.outputTokens,
        row.totalTokens,
        row.estimatedTextTokens,
        row.cachedTokens,
        row.reasoningTokens,
        row.durationMs,
    ].join('\t'));
}
