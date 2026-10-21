import {
    appendFileSync,
    mkdirSync,
} from 'node:fs';
import {
    resolve,
} from 'node:path';

const processTotals = new Map();
const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 3.3;

function finiteNonNegative(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
}

function firstNumber(...values) {
    for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number) && number >= 0) return number;
    }
    return 0;
}

function compactOperation(value, fallback = 'unclassified') {
    const clean = String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9а-яё:_./-]+/giu, '-')
        .replace(/-{2,}/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 120);
    return clean || fallback;
}

function estimateTextTokens(charCount) {
    const chars = Math.max(0, Number(charCount) || 0);
    return chars > 0 ? Math.ceil(chars / TOKEN_ESTIMATE_CHARS_PER_TOKEN) : 0;
}

export function normalizeAiTokenUsage(usage) {
    const source = usage && typeof usage === 'object' ? usage : {};
    const inputTokens = firstNumber(
        source.prompt_tokens,
        source.input_tokens,
        source.inputTokens,
        source.promptTokens,
        source.promptTokenCount,
    );
    const outputTokens = firstNumber(
        source.completion_tokens,
        source.output_tokens,
        source.outputTokens,
        source.completionTokens,
        source.candidatesTokenCount,
    );
    const totalTokens = firstNumber(
        source.total_tokens,
        source.totalTokens,
        source.totalTokenCount,
        inputTokens + outputTokens,
    );
    const cachedTokens = firstNumber(
        source.prompt_tokens_details?.cached_tokens,
        source.input_tokens_details?.cached_tokens,
        source.inputTokensDetails?.cachedTokens,
        source.cached_tokens,
        source.cachedContentTokenCount,
        finiteNonNegative(source.cache_read_input_tokens) + finiteNonNegative(source.cache_creation_input_tokens),
    );
    const reasoningTokens = firstNumber(
        source.completion_tokens_details?.reasoning_tokens,
        source.output_tokens_details?.reasoning_tokens,
        source.outputTokensDetails?.reasoningTokens,
        source.reasoning_tokens,
        source.thoughtsTokenCount,
    );
    const audioInputTokens = firstNumber(
        source.prompt_tokens_details?.audio_tokens,
        source.input_tokens_details?.audio_tokens,
        source.audio_input_tokens,
    );
    const audioOutputTokens = firstNumber(
        source.completion_tokens_details?.audio_tokens,
        source.output_tokens_details?.audio_tokens,
        source.audio_output_tokens,
    );

    const usageAvailable = Object.keys(source).length > 0 && (
        totalTokens > 0 ||
        inputTokens > 0 ||
        outputTokens > 0 ||
        cachedTokens > 0 ||
        reasoningTokens > 0 ||
        audioInputTokens > 0 ||
        audioOutputTokens > 0 ||
        'total_tokens' in source ||
        'totalTokens' in source ||
        'prompt_tokens' in source ||
        'input_tokens' in source ||
        'completion_tokens' in source ||
        'output_tokens' in source ||
        'promptTokenCount' in source ||
        'candidatesTokenCount' in source ||
        'totalTokenCount' in source
    );

    return {
        usageAvailable,
        inputTokens,
        outputTokens,
        totalTokens: totalTokens || inputTokens + outputTokens,
        cachedTokens,
        reasoningTokens,
        audioInputTokens,
        audioOutputTokens,
    };
}

export function inferAiTokenOperation({
    operation = '',
    capability = 'text',
    systemPrompt = '',
    userPrompt = '',
} = {}) {
    if (String(operation ?? '').trim()) return compactOperation(operation);

    const haystack = `${systemPrompt}\n${userPrompt}`.toLowerCase().slice(0, 8000);

    const rules = [
        [/авторезюме|auto[- ]?summary/iu, 'auto-summary'],
        [/иерархическ|недельн.*резюм|месячн.*резюм|weekly summary|monthly summary/iu, 'hierarchical-summary'],
        [/участник.*группов|целев.*участник|упоминан.*участник/iu, 'participant-analysis'],
        [/всей.*(?:истори|баз).*конф|всей.*переписк|chat database/iu, 'chat-database-analysis'],
        [/афиш|событи|мероприят|venue|площадк|анонс/iu, 'event-analysis'],
        [/промпт.*генератор.*изображ|визуальн.*бриф/iu, 'image-prompt'],
        [/изображени|картинк|vision/iu, capability === 'image' ? 'image-generation' : 'vision-analysis'],
        [/стиль.*общени|манер.*общени/iu, 'style-personalization'],
        [/досье|персонализац/iu, 'dossier-personalization'],
        [/наталь|астролог|прашн/iu, 'astrology'],
        [/резюм|summary/iu, 'manual-summary'],
    ];

    for (const [pattern, label] of rules) {
        if (pattern.test(haystack)) return label;
    }

    if (capability === 'vision') return 'vision-analysis';
    if (capability === 'image') return 'image-generation';
    if (capability === 'audio') return 'audio-transcription';
    return 'chat-text';
}

function safeMetadata(value) {
    if (!value || typeof value !== 'object') return {};
    const result = {};
    for (const [key, raw] of Object.entries(value)) {
        if (raw == null) continue;
        if (typeof raw === 'number' || typeof raw === 'boolean') {
            result[String(key).slice(0, 80)] = raw;
            continue;
        }
        const text = String(raw).trim();
        if (!text) continue;
        result[String(key).slice(0, 80)] = text.slice(0, 240);
    }
    return result;
}

function dailyLogPath(now = new Date()) {
    const directory = resolve(
        String(process.env.AI_TOKEN_USAGE_LOG_DIR || './data/ai-token-usage').trim() || './data/ai-token-usage',
    );
    const date = now.toISOString().slice(0, 10);
    mkdirSync(directory, { recursive: true });
    return resolve(directory, `${date}.jsonl`);
}

function addTotals(key, row) {
    const previous = processTotals.get(key) || {
        requests: 0,
        providerTokenRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        estimatedTextTokens: 0,
    };
    const next = {
        requests: previous.requests + 1,
        providerTokenRequests: previous.providerTokenRequests + (row.usageSource === 'provider' ? 1 : 0),
        inputTokens: previous.inputTokens + row.inputTokens,
        outputTokens: previous.outputTokens + row.outputTokens,
        totalTokens: previous.totalTokens + row.totalTokens,
        cachedTokens: previous.cachedTokens + row.cachedTokens,
        reasoningTokens: previous.reasoningTokens + row.reasoningTokens,
        estimatedTextTokens: previous.estimatedTextTokens + row.estimatedTextTokens,
    };
    processTotals.set(key, next);
    return next;
}

export function getAiTokenUsageProcessTotals() {
    return new Map([...processTotals.entries()].map(([key, value]) => [key, { ...value }]));
}

export function resetAiTokenUsageProcessTotals() {
    processTotals.clear();
}

export function recordAiTokenUsage({
    operation = '',
    capability = 'text',
    provider = 'unknown',
    keyName = '',
    model = 'unknown',
    transport = '',
    usage = null,
    inputChars = 0,
    outputChars = 0,
    imageCount = 0,
    durationMs = 0,
    success = true,
    metadata = null,
    systemPrompt = '',
    userPrompt = '',
    now = new Date(),
} = {}) {
    const normalized = normalizeAiTokenUsage(usage);
    const safeInputChars = finiteNonNegative(inputChars);
    const safeOutputChars = finiteNonNegative(outputChars);
    const operationName = inferAiTokenOperation({
        operation,
        capability,
        systemPrompt,
        userPrompt,
    });
    const estimatedTextTokens = normalized.usageAvailable
        ? 0
        : estimateTextTokens(safeInputChars + safeOutputChars);
    const usageSource = normalized.usageAvailable
        ? 'provider'
        : estimatedTextTokens > 0
            ? 'estimated'
            : 'unavailable';
    const row = {
        timestamp: now.toISOString(),
        operation: operationName,
        capability: compactOperation(capability, 'text'),
        provider: compactOperation(provider, 'unknown'),
        keyName: String(keyName ?? '').trim().slice(0, 120),
        model: String(model ?? 'unknown').trim().slice(0, 180) || 'unknown',
        transport: compactOperation(transport, 'unknown'),
        success: Boolean(success),
        usageSource,
        inputTokens: normalized.inputTokens,
        outputTokens: normalized.outputTokens,
        totalTokens: normalized.totalTokens,
        cachedTokens: normalized.cachedTokens,
        reasoningTokens: normalized.reasoningTokens,
        audioInputTokens: normalized.audioInputTokens,
        audioOutputTokens: normalized.audioOutputTokens,
        estimatedTextTokens,
        inputChars: safeInputChars,
        outputChars: safeOutputChars,
        imageCount: finiteNonNegative(imageCount),
        durationMs: finiteNonNegative(durationMs),
        metadata: safeMetadata(metadata),
    };

    const aggregateKey = `${row.operation}|${row.provider}|${row.model}`;
    const totals = addTotals(aggregateKey, row);
    const requestId = String(row.metadata?.requestId ?? '').trim();
    const operationId = String(row.metadata?.operationId ?? '').trim();

    console.log(
        '[AI TOKEN USAGE]',
        `requestId=${requestId || '-'}`,
        `operationId=${operationId || '-'}`,
        `operation=${row.operation}`,
        `provider=${row.provider}`,
        `model=${row.model}`,
        `capability=${row.capability}`,
        `transport=${row.transport}`,
        `source=${row.usageSource}`,
        `input=${row.usageSource === 'provider' ? row.inputTokens : '?'}`,
        `output=${row.usageSource === 'provider' ? row.outputTokens : '?'}`,
        `total=${row.usageSource === 'provider' ? row.totalTokens : '?'}`,
        `cached=${row.cachedTokens}`,
        `reasoning=${row.reasoningTokens}`,
        `estimatedText=${row.estimatedTextTokens}`,
        `durationMs=${row.durationMs}`,
    );
    console.log(
        '[AI TOKEN TOTAL]',
        `requestId=${requestId || '-'}`,
        `operationId=${operationId || '-'}`,
        `operation=${row.operation}`,
        `provider=${row.provider}`,
        `model=${row.model}`,
        `requests=${totals.requests}`,
        `providerRequests=${totals.providerTokenRequests}`,
        `input=${totals.inputTokens}`,
        `output=${totals.outputTokens}`,
        `total=${totals.totalTokens}`,
        `cached=${totals.cachedTokens}`,
        `reasoning=${totals.reasoningTokens}`,
        `estimatedText=${totals.estimatedTextTokens}`,
    );

    try {
        appendFileSync(dailyLogPath(now), `${JSON.stringify(row)}\n`, 'utf8');
    } catch (error) {
        console.warn(
            '[AI TOKEN LOG WRITE ERROR]',
            String(error?.message ?? error).slice(0, 300),
        );
    }

    return row;
}
