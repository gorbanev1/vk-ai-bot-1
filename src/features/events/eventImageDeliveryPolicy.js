const NON_DISPLAY_IMAGE_TYPES = /(?:^|[-_ ])(?:avatar|emoji|reaction|sticker|favicon|badge|icon|logo|ui)(?:$|[-_ ])/iu;

export function isMultiAnnouncementForImageDelivery(event, inferredMulti = false) {
    if (Object.hasOwn(event || {}, 'isMultiAnnouncement')) return Boolean(event.isMultiAnnouncement);
    if (Object.hasOwn(event || {}, 'is_multi_announcement')) return Number(event.is_multi_announcement) !== 0;
    return Boolean(inferredMulti);
}

export function shouldRejectImageFactForDelivery(event, fact, inferredMulti = false) {
    if (!isMultiAnnouncementForImageDelivery(event, inferredMulti)) return false;
    const type = String(fact?.type || fact?.imageType || '').trim().toLowerCase();
    return fact?.poster === false || NON_DISPLAY_IMAGE_TYPES.test(type);
}
