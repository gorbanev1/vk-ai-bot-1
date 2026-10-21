export const GPT_MODEL_LADDER = Object.freeze([
    Object.freeze({ model: 'gpt-5.6-luna', mode: 'default', attempts: 1 }),
    Object.freeze({ model: 'gpt-5.6-terra', mode: 'default', attempts: 1 }),
    Object.freeze({ model: 'gpt-5.6-sol', mode: 'default', attempts: 1 }),
    Object.freeze({ model: 'gpt-6.1-sol', mode: 'pro3', attempts: 3 }),
    Object.freeze({ model: 'gpt-6-astra', mode: 'astra', attempts: 2 }),
]);

// Kept as an import alias for event-parser call sites during the migration.
export const PARSER_MODEL_LADDER = GPT_MODEL_LADDER;

export const POSTER_VISION_MODEL_LADDER = Object.freeze([
    Object.freeze({ model: 'gpt-5.6-luna', mode: 'default', detail: 'high', reasoningEffort: 'none', attempts: 1 }),
    Object.freeze({ model: 'gpt-5.6-terra', mode: 'default', detail: 'high', reasoningEffort: 'none', attempts: 1 }),
    Object.freeze({ model: 'gpt-6.1-sol', mode: 'pro3', detail: 'original', reasoningEffort: 'low', attempts: 3 }),
    Object.freeze({ model: 'gpt-6-sol', mode: 'pro3', detail: 'original', reasoningEffort: 'none', attempts: 3 }),
    Object.freeze({ model: 'gpt-6-astra', mode: 'astra', detail: 'original', reasoningEffort: 'low', stream: true, attempts: 2 }),
]);

export const POSTER_VISION_LUNA_PROBE = Object.freeze({
    model: 'gpt-5.6-luna',
    intervalMin: 3,
    intervalMax: 5,
    attempts: 1,
    detail: 'high',
    reasoningEffort: 'none',
});

export function createPosterVisionLadder({ probeLuna = false, preferredLuna = false } = {}) {
    if (!(probeLuna || preferredLuna)) return POSTER_VISION_MODEL_LADDER;
    const luna = Object.freeze({
        model: POSTER_VISION_LUNA_PROBE.model,
        mode: 'default',
        detail: POSTER_VISION_LUNA_PROBE.detail,
        reasoningEffort: POSTER_VISION_LUNA_PROBE.reasoningEffort,
        attempts: POSTER_VISION_LUNA_PROBE.attempts,
    });
    return Object.freeze([luna, ...POSTER_VISION_MODEL_LADDER.filter((step) => step.model !== luna.model)]);
}

export function resolveParserLadderRuntimeModelId(model, { capability = 'text', normalize } = {}) {
    const explicitModel = String(model ?? '').trim();
    // Parser profiles may deliberately pin a legacy/cheaper model generation.
    // Preserve explicit 5.6 IDs for text as well as vision; the provider, not
    // the compatibility alias normalizer, must decide whether that model exists.
    if (/^gpt-5[.]6-(?:luna|terra|sol)$/iu.test(explicitModel)) return explicitModel;
    if (capability === 'vision') return explicitModel;
    return typeof normalize === 'function' ? normalize(explicitModel) : explicitModel;
}

export function modelAttemptLimit(model, fallback = 3) {
    const id = String(model ?? '').trim().toLowerCase();
    if (/(?:^|[\/_-])luna(?:$|[\/_-])/u.test(id)) return 4;
    if (/(?:^|[\/_-])gpt-6[.]1-sol(?:$|[\/_-])/u.test(id)) return 3;
    if (/(?:^|[\/_-])(?:gpt-6(?:[._-]0)?-astra|astra)(?:$|[\/_-])/u.test(id)) return 2;
    const safeFallback = Number(fallback);
    return Number.isSafeInteger(safeFallback) && safeFallback > 0 ? safeFallback : 3;
}

export function normalizeGpt6ModelId(model, fallback = 'gpt-6-luna') {
    const id = String(model ?? '').trim().toLowerCase();
    if (!id) return fallback;
    if (/(?:gpt[-_ ]?image|dall[\s_-]?e|imagine)/iu.test(id)) return id;
    if (/gpt[-_ ]?5[._-]?4[-_ ]?mini/u.test(id)) return 'gpt-6-luna';
    if (/gpt[-_ ]?5[._-]?4/u.test(id)) return 'gpt-6.1-sol';
    if (/gpt[-_ ]?5[._-]?5/u.test(id)) return 'gpt-6.1-sol';
    if (/gpt[-_ ]?5[._-]?6[-_ ]?(?:luna|terra)/u.test(id)) return 'gpt-6-luna';
    if (/gpt[-_ ]?5[._-]?6[-_ ]?sol/u.test(id)) return 'gpt-6.1-sol';
    if (/(?:^|[\/_-])(?:gpt-6(?:[._-]0)?-astra|astra)(?:$|[\/_-])/u.test(id)) return 'gpt-6-astra';
    if (/gpt[-_ ]?6[.]1[-_ ]?sol/u.test(id)) return 'gpt-6.1-sol';
    if (/gpt[-_ ]?6[-_ ]?sol/u.test(id)) return 'gpt-6.1-sol';
    if (/gpt[-_ ]?6[-_ ]?terra/u.test(id)) return 'gpt-6-luna';
    if (/gpt[-_ ]?6[-_ ]?luna/u.test(id)) return 'gpt-6-luna';
    return fallback;
}

export function getGptModelLadderFrom(model) {
    const modelId = resolveParserLadderRuntimeModelId(model, { normalize: (value) => normalizeGpt6ModelId(value, '') });
    const index = GPT_MODEL_LADDER.findIndex((step) => step.model === modelId);
    return GPT_MODEL_LADDER.slice(index < 0 ? 0 : index);
}

export function parserModelAttempts(candidate) {
    const configured = Number(candidate?.attemptLimit ?? candidate?.attempts);
    return Number.isSafeInteger(configured) && configured > 0
        ? configured
        : modelAttemptLimit(candidate?.model, 3);
}

export function createParserModelSerialQueue() {
    let tail = Promise.resolve();
    return (task) => {
        const result = tail.then(task, task);
        tail = result.then(() => undefined, () => undefined);
        return result;
    };
}

export function isRetiredParserModelError(error) {
    const message = String(error?.message ?? error ?? '');
    return /\b(?:model\s+[^\s]+\s+(?:has\s+been\s+)?retired|retired\s+model|model\s+[^\s]+\s+decommissioned)\b/iu.test(message);
}
