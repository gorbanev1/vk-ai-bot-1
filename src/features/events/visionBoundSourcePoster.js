import { evaluatePosterFactForEvent } from './eventPosterMatching.js';

export function getVisionBoundSourcePosterPaths(event) {
    if (!event || !(event.isMultiAnnouncement === true || Number(event.is_multi_announcement) === 1)) return [];
    const sourcePaths = Array.isArray(event.sourceImagePaths) ? event.sourceImagePaths : [];
    const facts = Array.isArray(event.imageVisionFacts) ? event.imageVisionFacts : [];
    const candidates = new Set();

    for (const fact of facts) {
        const index = Number(fact?.index || 0);
        if (fact?.poster !== true || !Number.isSafeInteger(index) || index < 1 || index > sourcePaths.length) continue;
        if (!evaluatePosterFactForEvent(event, fact).accepted) continue;
        const path = String(sourcePaths[index - 1] || '').trim().replace(/\\/gu, '/');
        if (!path || /(?:^|\/)event_message_cards\/|(?:^|\/)event_generated_fallbacks\/|-event-\d+\.png$/iu.test(path)) continue;
        candidates.add(path);
    }

    return candidates.size === 1 ? [...candidates] : [];
}
