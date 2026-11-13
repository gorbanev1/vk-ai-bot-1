/**
 * Telegram public HTML media evidence. No login, media download or browser
 * navigation occurs in this module.
 */
const VIDEO_MARKER = /\btgme_widget_message_(?:video(?:_thumb|_player|_wrap|_duration)?|roundvideo(?:_wrap)?)\b/iu;
const PHOTO_MARKER = /\btgme_widget_message_(?:photo_wrap|photo\b)/iu;
const VIDEO_PREVIEW_MARKER = /\btgme_widget_message_video_thumb\b|<video\b[^>]*\bposter\s*=/iu;
const DIRECT_VIDEO_MARKER = /<(?:video|source)\b[^>]*\bsrc\s*=\s*(?:"https?:\/\/[^"]+"|'https?:\/\/[^']+')/iu;
const VIDEO_DURATION = /<[^>]*class\s*=\s*(?:"[^"]*\b(?:tgme_widget_message_video_duration|message_video_duration)\b[^"]*"|'[^']*\b(?:tgme_widget_message_video_duration|message_video_duration)\b[^']*')[^>]*>([\s\S]{0,120}?)<\//iu;

export function parseTelegramVideoDuration(value) {
    const text = String(value ?? '').replace(/<[^>]+>/gu, ' ').trim();
    const long = text.match(/(?:^|\s)(\d{1,3}):([0-5]\d):([0-5]\d)(?:\s|$)/u);
    if (long) return Number(long[1]) * 3600 + Number(long[2]) * 60 + Number(long[3]);
    const short = text.match(/(?:^|\s)(\d{1,3}):([0-5]\d)(?:\s|$)/u);
    return short ? Number(short[1]) * 60 + Number(short[2]) : null;
}


function mediaAttribute(tag, name) {
    return (String(tag).match(new RegExp('\\b'+name+'\\s*=\\s*(?:"([^"]*)"|\\x27([^\\x27]*)\\x27)', 'iu'))?.slice(1).find(value=>value!=null)||'')
        .replace(/&amp;/giu,'&').replace(/&#(?:0*38|x0*26);/giu,'&').replace(/&quot;/giu,'"');
}
export function extractTelegramPostVideoUrls(html) {
    const block=String(html||'').replace(/<tg-emoji\b[^>]*>[\s\S]*?<\/tg-emoji>/giu,'');
    const urls=[];
    for (const match of block.matchAll(/<video\b[^>]*>(?:[\s\S]*?<\/video>)?/giu)) {
        const tag=match[0].match(/^<video\b[^>]*>/iu)?.[0]||'';
        const classes=mediaAttribute(tag,'class');
        // Public DOM includes WebM emojis in text and reactions. Only source
        // attachment players count there; a standalone <video> is supported too.
        if (/\btgme_widget_message(?:_text)?\b/iu.test(block) && !/\btgme_widget_message_(?:video|roundvideo)\b/iu.test(classes)) continue;
        for (const node of [tag,...(match[0].match(/<source\b[^>]*>/giu)||[])]) {
            const url=mediaAttribute(node,'src');
            if (/^https?:\/\//iu.test(url) && !/sticker|emoji/iu.test(mediaAttribute(node,'type'))) urls.push(url);
        }
    }
    return [...new Set(urls)];
}
export function telegramMediaUnavailableReason(html, videoUrls=extractTelegramPostVideoUrls(html)) {
    // An unsupported-player template exists even in playable video markup.
    // A direct attachment URL wins over that hidden template.
    if (videoUrls.length) return '';
    const labels=[...String(html||'').matchAll(/<[^>]+class=["'][^"']*\bmessage_media_not_supported_label\b[^"']*["'][^>]*>([\s\S]*?)<\//giu)]
        .map(m=>m[1].replace(/<[^>]*>/gu,' ').trim());
    if(labels.some(label=>/^Media is too big$/iu.test(label)))return 'too-big';
    if(labels.some(label=>/^This media is not supported in your browser$/iu.test(label)))return 'browser-unsupported';
    return '';
}

export function inspectTelegramPublicPostMedia(html) {
    const block = String(html ?? '');
    const videoUrls = extractTelegramPostVideoUrls(block);
    const hasVideo = VIDEO_MARKER.test(block) || videoUrls.length > 0;
    const mediaUnavailableReason = telegramMediaUnavailableReason(block, videoUrls);
    const hasPhoto = PHOTO_MARKER.test(block);
    const videoPreviewAvailable = hasVideo && VIDEO_PREVIEW_MARKER.test(block);
    const directVideoUrlVisible = videoUrls.length > 0;
    const duration = hasVideo ? block.match(VIDEO_DURATION)?.[1] : null;
    return {
        mediaType: hasVideo ? (hasPhoto ? 'mixed' : 'video') : (hasPhoto ? 'photo' : 'unknown'),
        hasVideo,
        hasPhoto,
        videoUrls,
        mediaUnavailableReason,
        videoPreviewAvailable,
        videoDurationSeconds: duration == null ? null : parseTelegramVideoDuration(duration),
        // An image/thumbnail is not proof that video playback is accessible.
        videoAccess: !hasVideo ? 'not-applicable'
            : directVideoUrlVisible ? 'direct-url-visible'
                : videoPreviewAvailable ? 'preview-only'
                    : 'video-detected-unavailable',
    };
}

/**
 * Retry at most two event-like media posts via the public single-post embed.
 * This never signs in or visits Telegram Web; a successful embed still does
 * not imply that the video file is available.
 */
export async function enrichTelegramPostsWithPublicEmbed(posts, {
    fetchEmbedHtml,
    parsePosts,
    isEventCandidate = () => false,
    maxAttempts = 2,
} = {}) {
    if (!Array.isArray(posts) || !posts.length || typeof fetchEmbedHtml !== 'function' || typeof parsePosts !== 'function') return posts;
    let attempts = 0;
    // A known video takes priority over possibly text-only image-less posts.
    const ordered = [...posts].sort((a, b) => Number(Boolean(b?.hasVideo)) - Number(Boolean(a?.hasVideo)));
    for (const post of ordered) {
        if (attempts >= Math.max(0, Math.min(2, Number(maxAttempts) || 0))) break;
        const missingMedia = !Array.isArray(post?.imageUrls) || !post.imageUrls.length;
        const incompleteVideo = Boolean(post?.hasVideo && post.videoAccess !== 'direct-url-visible');
        if (!incompleteVideo && !missingMedia) continue;
        let eventCandidate = false;
        try { eventCandidate = Boolean(isEventCandidate(post)); } catch { continue; }
        if (!eventCandidate) continue;
        if (!/^[a-z0-9_]{5,}$/iu.test(String(post.channel || '')) || !Number.isSafeInteger(post.messageId) || post.messageId <= 0) continue;
        attempts += 1;
        try {
            const html = String(await fetchEmbedHtml(post) || '');
            const matching = parsePosts(html, post.channel).find((item) => item.messageId === post.messageId && item.channel.toLowerCase() === post.channel.toLowerCase());
            if (!matching) {
                post.mediaReviewStatus = 'public-embed-no-match';
                continue;
            }
            const originalImageUrls = Array.isArray(post.imageUrls) ? post.imageUrls : [];
            if (!originalImageUrls.length && Array.isArray(matching.imageUrls) &&
                matching.imageUrls.length && (matching.hasVideo || matching.hasPhoto)) {
                post.imageUrls = matching.imageUrls;
            }
            // Merge only verified media evidence for this message ID. Do not
            // overwrite source text, publication date or existing video flags.
            if (matching.hasVideo || matching.hasPhoto) {
                post.hasVideo = Boolean(post.hasVideo || matching.hasVideo);
                post.hasPhoto = Boolean(post.hasPhoto || matching.hasPhoto);
                post.mediaType = post.hasVideo ? (post.hasPhoto ? 'mixed' : 'video') : 'photo';
                if (matching.hasVideo) {
                    if (matching.videoAccess === 'direct-url-visible' ||
                        !post.videoAccess || post.videoAccess === 'video-detected-unavailable') {
                        post.videoAccess = matching.videoAccess;
                    }
                    if (matching.videoUrls?.length) post.videoUrls = matching.videoUrls;
                    post.mediaUnavailableReason = matching.mediaUnavailableReason || '';
                    post.videoPreviewAvailable = Boolean(post.videoPreviewAvailable || matching.videoPreviewAvailable);
                    post.videoDurationSeconds = matching.videoDurationSeconds ?? post.videoDurationSeconds ?? null;
                }
            }
            post.mediaReviewStatus = 'public-embed-checked';
        } catch {
            // Optional recovery cannot fail the whole source.
            post.mediaReviewStatus = 'public-embed-failed';
        }
    }
    return posts;
}
