function clean(value) {
    return String(value ?? '').replace(/\s+/gu, ' ').trim();
}
const EFFORT_ALIASES = Object.freeze([
    { effort: 'max', source: '(?:max|maximum|макс(?:имум)?|максимальн(?:ый|ая|ое)?(?:\\s+(?:интеллект|уровень))?)' },
    { effort: 'xhigh', source: '(?:x[\\s_-]?high|extra[\\s_-]?high|very\\s+high|очень\\s+высок(?:ий|ая)?)' },
    { effort: 'high', source: '(?:high|высок(?:ий|ая)?|глубок(?:ий|ая)?)' },
    { effort: 'medium', source: '(?:medium|средн(?:ий|яя)?)' },
    { effort: 'low', source: '(?:low|низк(?:ий|ая)?)' },
]);
const LEFT = '(^|[\\s,.;:!?()\\[\\]{}«»"“”‘’/\\\\|+-])';
const RIGHT = '(?=$|[\\s,.;:!?()\\[\\]{}«»"“”‘’/\\\\|+-])';
export function extractReasoningEffortModifier(input) {
    const body = clean(input);
    const labelledSource = EFFORT_ALIASES.map((alias) => alias.source).join('|');
    const labelled = new RegExp(String.raw`(?:^|\s)(?:интеллект|уровень\s+интеллекта)\s*[:=]?\s*(${labelledSource})(?=$|\s|[,.;:!?()\[\]{}«»])`, 'iu').exec(body);
    if (labelled) {
        const token = labelled[1];
        const effort = EFFORT_ALIASES.find((alias) => new RegExp(`^(?:${alias.source})$`, 'iu').test(token))?.effort || '';
        const start = labelled.index;
        const prefix = body.slice(0, start).trimEnd();
        const suffix = body.slice(start + labelled[0].length).replace(/^\s*[,;:–—-]?\s*/u, '');
        return { effort, token, source: start === 0 ? 'prefix' : 'any-position', body: clean(`${prefix} ${suffix}`).replace(/^[,.;:!?]+\s*/u, '') };
    }
    for (const alias of EFFORT_ALIASES) {
        const match = new RegExp(`${LEFT}(${alias.source})${RIGHT}`, 'iu').exec(body);
        if (!match) continue;
        const start = match.index + match[1].length;
        const end = start + match[2].length;
        const prefix = body.slice(0, start);
        const suffix = body.slice(end).replace(/^\s*[,;:–—-]?\s*/u, prefix ? ' ' : '');
        return { effort: alias.effort, token: match[2], source: start === 0 ? 'prefix' : 'any-position', body: clean(`${prefix}${suffix}`).replace(/^[,.;:!?]+\s*/u, '') };
    }
    return { effort: '', token: '', source: 'implicit', body };
}
export function getDefaultReasoningEffortForMode(mode) {
    const value = clean(mode).toLowerCase();
    if (value === 'default' || value === 'pro' || value === 'pro1' || value === 'luna') return 'none';
    if (['astra', 'pro2', 'pro3', 'sol', 'terra'].includes(value)) return 'low';
    return 'none';
}
export function formatReasoningHelp() {
    return 'Reasoning: Luna — none; Sol и Astra — low (при необходимости можно явно выбрать другой поддерживаемый уровень).';
}
