function clean(value) {
    return String(value ?? '').replace(/\s+/gu, ' ').trim();
}
const EFFORT_ALIASES = Object.freeze([
    { effort: 'max', source: '(?:max|maximum|макс(?:имум)?|максимальн(?:ый|ая|ое)?\\s+интеллект)' },
    { effort: 'xhigh', source: '(?:x[\\s_-]?high|extra[\\s_-]?high|очень\\s+высок(?:ий|ая)?)' },
    { effort: 'high', source: '(?:high|высок(?:ий|ая)?|глубок(?:ий|ая)?)' },
    { effort: 'medium', source: '(?:medium|средн(?:ий|яя)?)' },
    { effort: 'low', source: '(?:low|низк(?:ий|ая)?)' },
]);
const LEFT = '(^|[\\s,.;:!?()\\[\\]{}«»"“”‘’/\\\\|+-])';
const RIGHT = '(?=$|[\\s,.;:!?()\\[\\]{}«»"“”‘’/\\\\|+-])';
export function extractReasoningEffortModifier(input) {
    const body = clean(input);
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
    if (value === 'astra') return 'max';
    if (['pro', 'pro2', 'pro3'].includes(value)) return 'high';
    return 'medium';
}
export function formatReasoningHelp() {
    return 'Reasoning: low / medium / high / xhigh / max. Astra по умолчанию использует max.';
}
