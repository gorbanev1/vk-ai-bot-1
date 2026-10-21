/** VK Public capture fingerprint v2: full source text and verified image identities.
 * This is a change-detection signal, NOT a proof that Vision processed each media.
 * Keep it separate from sourceContentHash.js: Telegram and legacy callers keep
 * their original hash contract. A legacy VK Public hash will be reprocessed once.
 */
import { createHash } from 'node:crypto';

const clean = (value) => String(value ?? '').trim();
const values = (value) => Array.isArray(value) ? value : [];

function mediaIdentity(item) {
    const id = clean(item?.attachmentKey || item?.vkPhotoId).toLowerCase();
    // Do not lowercase a URL or drop an unverified query parameter; either may
    // distinguish two pictures. A proven photo ID is stable across CDN URLs.
    const identity = id ? ['vk-photo', id] : ['url', clean(item?.url)];
    return [
        clean(item?.sourceLayerId || item?.layerId || item?.origin),
        Number(item?.repostDepth ?? 0),
        ...identity,
    ];
}

export function vkPublicCapturePayload(post, reparseEpoch = process.env.GIGORAVE_EVENT_REPARSE_EPOCH ?? '') {
    const media = values(post?.imageMedia).filter((item) => clean(item?.url));
    const representedUrls = new Set(media.map((item) => clean(item.url)));
    const identities = media.map(mediaIdentity);
    for (const url of values(post?.imageUrls).map(clean).filter(Boolean)) {
        if (!representedUrls.has(url)) identities.push(['', 0, 'url', url]);
    }
    return {
        version: 'vk-public-capture-media-identity-v3',
        reparseEpoch: clean(reparseEpoch),
        sourceUrl: clean(post?.sourceUrl),
        text: String(post?.text ?? ''),
        contentText: String(post?.contentText ?? ''),
        repostText: String(post?.repostText ?? ''),
        publishedAt: Number(post?.publishedAt ?? 0),
        media: identities,
        links: values(post?.links).map(clean).filter(Boolean),
        repostUrls: values(post?.repostUrls).map(clean).filter(Boolean),
        eventLinks: values(post?.eventLinks).map((item) => [clean(item?.url || item), clean(item?.text)]),
    };
}

export function createVkPublicCaptureHash(post, reparseEpoch) {
    return createHash('sha256')
        .update(JSON.stringify(vkPublicCapturePayload(post, reparseEpoch)))
        .digest('hex');
}
