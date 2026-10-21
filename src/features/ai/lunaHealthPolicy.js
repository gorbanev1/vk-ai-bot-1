// Old health samples omitted failures because the error serializer threw.
// Keep them for diagnostics, but never use that biased sample for promotion.
export const LUNA_HEALTH_SAMPLE_VERSION = 2;

export function eligibleLunaHealthSamples(samples, now = Date.now()) {
    return (Array.isArray(samples) ? samples : []).filter((item) => {
        const age = now - Date.parse(item.at || '');
        return item.version === LUNA_HEALTH_SAMPLE_VERSION &&
            typeof item.ok === 'boolean' && age >= 0 && age <= 7 * 24 * 60 * 60 * 1000;
    });
}

export function lunaHealthRate(samples, now = Date.now()) {
    const rows = eligibleLunaHealthSamples(samples, now);
    return rows.length ? rows.filter((item) => item.ok).length / rows.length : 0;
}

export function canPromoteLunaHealth(samples, now = Date.now()) {
    return eligibleLunaHealthSamples(samples, now).length >= 10 && lunaHealthRate(samples, now) >= 0.8;
}

export function lunaHealthDay(at, timeZone) {
    const date = new Date(at);
    if (!Number.isFinite(date.getTime())) return '';
    const p = new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date).reduce((out, part) => { out[part.type] = part.value; return out; }, {});
    return `${p.year}-${p.month}-${p.day}`;
}

export function hasLunaHealthModel(profiles, model) {
    return Object.values(profiles || {}).some((steps) =>
        Array.isArray(steps) && steps.some((step) => step.model === model));
}
