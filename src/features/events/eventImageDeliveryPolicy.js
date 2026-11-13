const NON_DISPLAY_IMAGE_TYPES = /(?:^|[-_ ])(?:avatar|emoji|reaction|sticker|favicon|badge|icon|logo|ui)(?:$|[-_ ])/iu;

export function isMultiAnnouncementForImageDelivery(event, inferredMulti = false) {
    if (Object.hasOwn(event || {}, 'isMultiAnnouncement')) return Boolean(event.isMultiAnnouncement);
    if (Object.hasOwn(event || {}, 'is_multi_announcement')) return Number(event.is_multi_announcement) !== 0;
    return Boolean(inferredMulti);
}

// Image indexes belong to a source gallery, not to the merged event. A
// deduplicated card can retain VK source facts and a Telegram-bound poster.
export function getEventImageFactForDelivery(event, imagePath) {
    const normalize = (value) => String(value ?? '').trim().replace(/\\+/gu, '/').replace(/^\.\//u, '');
    const path = normalize(imagePath);
    if (!path) return null;
    const posterFacts = Array.isArray(event?.posterVisionFacts) ? event.posterVisionFacts : [];
    const sourceFacts = Array.isArray(event?.imageVisionFacts) ? event.imageVisionFacts : [];
    const bound = [...posterFacts, ...sourceFacts].find((fact) => normalize(fact?.imagePath) === path);
    if (bound) return bound;
    const sourcePaths = Array.isArray(event?.sourceImagePaths) ? event.sourceImagePaths : [];
    const sourceIndex = sourcePaths.findIndex((value) => normalize(value) === path);
    if (sourceIndex < 0) return null;
    return sourceFacts.find((fact) => Number(fact?.index) === sourceIndex + 1 &&
        (!fact?.imagePath || normalize(fact.imagePath) === path)) || null;
}

export function shouldRejectImageFactForDelivery(event, fact, inferredMulti = false) {
    if (!isMultiAnnouncementForImageDelivery(event, inferredMulti)) return false;
    const type = String(fact?.type || fact?.imageType || '').trim().toLowerCase();
    return fact?.poster === false || NON_DISPLAY_IMAGE_TYPES.test(type);
}
