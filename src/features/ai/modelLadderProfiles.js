import { POSTER_VISION_MODEL_LADDER } from './parserModelLadder.js';

const CATALOG = [
    ['gpt-5.6-luna', ['5.6 luna', '5.6 луна', 'luna56']],
    ['gpt-5.6-terra', ['5.6 terra', '5.6 терра', 'terra56']],
    ['gpt-5.6-sol', ['5.6 sol', '5.6 сол', 'sol56']],
    ['gpt-6-luna', ['6 luna', '6 луна', 'луна', 'luna']],
    ['gpt-6-sol', ['6 sol', '6 сол', 'sol']],
    ['gpt-6.1-sol', ['6.1 sol', '6.1 сол', '6 1 sol', '6 1 сол']],
    ['gpt-6-astra', ['6 astra', '6 астра', 'астра', 'astra']],
];
const normalize = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/[._-]+/gu, ' ').replace(/\s+/gu, ' ').trim();
const ALIASES = new Map(CATALOG.flatMap(([id, aliases]) => [[normalize(id), id], ...aliases.map(alias => [normalize(alias), id])]));
export const MODEL_LADDER_PROFILE_LABELS = Object.freeze({
    chat: 'Обычный чат', conversation: 'Беседы', 'chat-vision': 'Изображения в чате',
    'parser-all-text': 'Парсер все · текст', 'parser-all-vision': 'Парсер все · изображения',
    'parser-all-new-text': 'Парсер все новые · текст', 'parser-all-new-vision': 'Парсер все новые · изображения',
});
export const DEFAULT_MODEL_LADDER_PROFILES = Object.freeze({
    chat: [{ model: 'gpt-6-luna', attempts: 1, reasoningEffort: 'low' }, { model: 'gpt-5.6-luna', attempts: 1 }, { model: 'gpt-6.1-sol', attempts: 3 }, { model: 'gpt-6-astra', attempts: 2 }],
    conversation: [{ model: 'gpt-6-luna', attempts: 1, reasoningEffort: 'low' }, { model: 'gpt-5.6-luna', attempts: 1 }, { model: 'gpt-6.1-sol', attempts: 3 }, { model: 'gpt-6-astra', attempts: 2 }],
    'chat-vision': [{ model: 'gpt-6-luna', attempts: 1, detail: 'high', reasoningEffort: 'low' }, { model: 'gpt-5.6-luna', attempts: 1, detail: 'high', reasoningEffort: 'none' }, { model: 'gpt-6.1-sol', attempts: 3, detail: 'original', reasoningEffort: 'low' }, { model: 'gpt-6-astra', attempts: 2, detail: 'original', reasoningEffort: 'low' }],
    'parser-all-text': [
        { model: 'gpt-6-luna', attempts: 1, reasoningEffort: 'low' },
        { model: 'gpt-5.6-luna', attempts: 1, reasoningEffort: 'none' },
        { model: 'gpt-5.6-terra', attempts: 1, timeoutMs: 150000, reasoningEffort: 'none' },
        { model: 'gpt-6.1-sol', attempts: 3, reasoningEffort: 'low' },
        { model: 'gpt-6-astra', attempts: 2, reasoningEffort: 'low' },
    ],
    'parser-all-vision': POSTER_VISION_MODEL_LADDER.map(({ mode, ...step }) => ({ ...step })),
    'parser-all-new-text': [
        { model: 'gpt-6-luna', attempts: 1, reasoningEffort: 'low' },
        { model: 'gpt-5.6-luna', attempts: 1, reasoningEffort: 'none' },
        { model: 'gpt-5.6-terra', attempts: 1, timeoutMs: 150000, reasoningEffort: 'none' },
        { model: 'gpt-6.1-sol', attempts: 3, reasoningEffort: 'low' },
        { model: 'gpt-6-astra', attempts: 2, reasoningEffort: 'low' },
    ],
    'parser-all-new-vision': POSTER_VISION_MODEL_LADDER.map(({ mode, ...step }) => ({ ...step })),
});

// Explicit, one-time migration; do not reinsert Astra on every profile read,
// because the owner may subsequently edit the ladder. Phase-two policy is separate.
export function addAstraToVisionProfiles(profiles) {
    const next = structuredClone(profiles);
    for (const key of ['chat-vision', 'parser-all-vision', 'parser-all-new-vision']) {
        const steps = next[key] || DEFAULT_MODEL_LADDER_PROFILES[key];
        const existing = steps.find((step) => step.model === 'gpt-6-astra');
        const { mode, ...defaults } = POSTER_VISION_MODEL_LADDER.at(-1);
        next[key] = [...steps.filter((step) => step.model !== 'gpt-6-astra'),
            { ...defaults, ...existing, attempts: 2, stream: true }];
    }
    return next;
}
export function getModelAliasCatalog() { return CATALOG.map(([id, aliases]) => ({ id, aliases: [...aliases] })); }
export function resolveModelAlias(value) { return ALIASES.get(normalize(value)) || null; }
function parseLine(line) {
    const match = String(line).trim().match(/^(.+?)\s+(\d+)(?:\s+(.*))?$/u);
    if (!match) return { error: 'Не распознал количество попыток в строке: «' + line + '».' };
    const model = resolveModelAlias(match[1]);
    if (!model) return { error: 'Неизвестный алиас модели «' + match[1] + '».' };
    const attempts = Number(match[2]);
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) return { error: 'Попытки должны быть от 1 до 10.' };
    const step = { model, attempts };
    for (const token of String(match[3] || '').trim().split(/\s+/u).filter(Boolean)) {
        const [key, rawValue] = token.split('='); const k = normalize(key); const v = String(rawValue || '').toLowerCase();
        if (k === 'stream') step.stream = true;
        else if (['nostream', 'non stream'].includes(k)) step.stream = false;
        else if (k === 'detail' && ['low', 'high', 'original', 'auto'].includes(v)) step.detail = v;
        else if (['reasoning', 'effort'].includes(k) && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(v)) step.reasoningEffort = v;
        else if (['timeout', 'timeoutms'].includes(k) && /^\d+(?:ms|s|m)?$/iu.test(String(rawValue || ''))) { const n = Number(String(rawValue).match(/^\d+/u)[0]); const unit = String(rawValue).match(/ms|s|m$/iu)?.[0].toLowerCase() || 's'; step.timeoutMs = n * (unit === 'm' ? 60000 : unit === 's' ? 1000 : 1); }
        else return { error: 'Неизвестный параметр «' + token + '». Используй stream, nostream, detail=high|original, reasoning=none|low|medium|high, timeout=240s.' };
    }
    return { step };
}
function profileFor(value) {
    const key = normalize(value);
    return Object.keys(MODEL_LADDER_PROFILE_LABELS).find(id => normalize(id) === key || normalize(MODEL_LADDER_PROFILE_LABELS[id]) === key || (id === 'chat' && /обычн.*чат|^чат$/u.test(key)) || (id === 'conversation' && /бесед|групп/u.test(key)) || (id === 'chat-vision' && /изображ|картин|vision/u.test(key) && !/парсер/u.test(key)) || (id.startsWith('parser-all-new') && /парсер все новые|parser all new/u.test(key) && (id.endsWith('vision') ? /изображ|картин|vision|афиш/u.test(key) : /текст|text/u.test(key))) || (id.startsWith('parser-all-') && !id.startsWith('parser-all-new') && /парсер все(?:$|\s)|parser all(?! new)/u.test(key) && (id.endsWith('vision') ? /изображ|картин|vision|афиш/u.test(key) : /текст|text/u.test(key))));
}
export function parseModelLadderCommand(input) {
    let text = String(input ?? '').normalize('NFKC').trim().replace(/^\/?(?:гигорейв|gigorave)\s+/iu, '').trim();
    const command = text.match(/^лестниц(?:а|ы)(?=$|[\s:])/iu); if (!command) return null;
    text = text.slice(command[0].length).trim();
    text = text.replace(/^модел(?:ь|и|ей)\s+/iu, '').trim();
    if (!text || /^(?:модел(?:ь|и|ей)|показать|покажи|show)$/iu.test(text)) return { action: 'show' };
    const edit = text.match(/^(?:изменить|измени|change)(?:\s+([^:\n]+?))?(?:\s*:\s*|\s*\n\s*|\s*$)([\s\S]*)$/iu);
    if (!edit) return { action: 'help' };
    const defaultProfile = edit[1] ? profileFor(edit[1]) : null; const body = String(edit[2] || '').trim();
    if (!body) return defaultProfile ? { action: 'edit-prompt', profile: defaultProfile } : { action: 'edit-prompt-all' };
    const sections = []; let current = null;
    for (const raw of body.split(/\r?\n/u)) {
        const line = raw.trim(); if (!line) continue;
        const header = line.match(/^(?:\[([^\]]+)\]|([^:]+)):\s*$/u);
        if (header) { const profile = profileFor(header[1] || header[2]); if (!profile) return { action: 'invalid', error: 'Не распознал профиль «' + line + '».' }; current = { profile, steps: [] }; sections.push(current); continue; }
        if (!current) { if (!defaultProfile) return { action: 'invalid', error: 'Укажи заголовок профиля, например «чат:».' }; current = { profile: defaultProfile, steps: [] }; sections.push(current); }
        const parsed = parseLine(line); if (parsed.error) return { action: 'invalid', error: parsed.error }; current.steps.push(parsed.step);
    }
    if (!sections.length || sections.some(s => !s.steps.length)) return { action: 'invalid', error: 'В каждом профиле должна быть хотя бы одна модель.' };
    if (sections.some(s => new Set(s.steps.map(x => x.model)).size !== s.steps.length)) return { action: 'invalid', error: 'В профиле нельзя повторять одну модель.' };
    return { action: 'save', profiles: Object.fromEntries(sections.map(s => [s.profile, s.steps])) };
}
export function validateModelLadderProfiles(value) {
    const retired = model => /^gpt[-_ ]?5[._ -]?[45](?:$|[-_ ])/iu.test(String(model ?? '')) || /^gpt5[45]$/iu.test(String(model ?? ''));
    return Object.fromEntries(Object.keys(DEFAULT_MODEL_LADDER_PROFILES).map(key => {
        const provided = Array.isArray(value?.[key]) ? value[key] : DEFAULT_MODEL_LADDER_PROFILES[key];
        const clean = provided.filter(step => step && !retired(step.model))
            .map(step => ({ ...step, model: resolveModelAlias(step.model) || step.model, attempts: Math.max(1, Math.min(10, Number(step.attempts) || 1)) }));
        return [key, clean.length ? clean : structuredClone(DEFAULT_MODEL_LADDER_PROFILES[key])];
    }));
}
export function formatModelLadderProfiles(value = DEFAULT_MODEL_LADDER_PROFILES) { const aliases = new Map(CATALOG.map(([id, names]) => [id, names[0]])); return Object.entries(validateModelLadderProfiles(value)).map(([key, steps]) => [MODEL_LADDER_PROFILE_LABELS[key] + ' [' + key + ']:', ...steps.map(step => '  ' + (aliases.get(step.model) || step.model) + ' ' + step.attempts + (step.stream === true ? ' stream' : step.stream === false ? ' nostream' : '') + (step.detail ? ' detail=' + step.detail : '') + (step.reasoningEffort ? ' reasoning=' + step.reasoningEffort : '') + (step.timeoutMs ? ' timeout=' + Math.round(step.timeoutMs / 1000) + 's' : ''))].join(String.fromCharCode(10))).join(String.fromCharCode(10) + String.fromCharCode(10)); }
export function buildModelLadderHelp(profiles = DEFAULT_MODEL_LADDER_PROFILES) { return ['Текущие лестницы моделей:', formatModelLadderProfiles(profiles), '', 'Изменение: «лестница изменить» и ниже профили с моделями сверху вниз.', 'Профили: чат:, беседы:, изображения чата:, парсер все текст:, парсер все изображения:, парсер все новые текст:, парсер все новые изображения:.', 'Строка: <алиас> <1–10 попыток> [stream|nostream] [detail=high|original] [reasoning=none|low|medium|high] [timeout=240s].', 'Алиасы:', ...CATALOG.map(([id, names]) => id + ': ' + names.join(', '))].join(String.fromCharCode(10)); }
