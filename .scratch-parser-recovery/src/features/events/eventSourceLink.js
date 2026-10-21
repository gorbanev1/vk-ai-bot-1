function clean(value) {
    return String(value ?? '').trim();
}

export function classifyEventSourceUrl(value) {
    const source = clean(value);
    if (!source) return { platform: 'none', kind: 'none', exactPost: false };

    let url;
    try {
        url = new URL(source);
    } catch {
        return { platform: 'other', kind: 'page', exactPost: false };
    }

    const host = url.hostname.toLowerCase().replace(/^www\./u, '');
    const pathname = decodeURIComponent(url.pathname || '/').replace(/\/+$/u, '') || '/';

    if (host === 'vk.com' || host === 'vk.ru' || host === 'm.vk.com' || host === 'm.vk.ru') {
        const whole = `${pathname}${url.search}`;
        const wall = whole.match(/wall(-?\d+)_(\d+)/iu);
        if (wall) {
            return {
                platform: 'vk',
                kind: 'exact-post',
                exactPost: true,
                ownerId: Number(wall[1]),
                postId: Number(wall[2]),
            };
        }

        const segment = pathname.split('/').filter(Boolean)[0] || '';
        const eventPage = /^event\d+$/iu.test(segment);
        const community = /^(?:club|public)\d+$/iu.test(segment) || Boolean(segment);
        return {
            platform: 'vk',
            kind: eventPage ? 'event-page' : community ? 'feed-or-community' : 'page',
            exactPost: false,
            eventPage,
            screenName: segment,
        };
    }

    if (host === 't.me' || host === 'telegram.me') {
        const parts = pathname.split('/').filter(Boolean);
        const offset = parts[0]?.toLowerCase() === 's' ? 1 : 0;
        const channel = parts[offset] || '';
        const postId = Number(parts[offset + 1] || 0);
        if (channel && Number.isInteger(postId) && postId > 0) {
            return {
                platform: 'telegram',
                kind: 'exact-post',
                exactPost: true,
                channel,
                postId,
            };
        }
        return {
            platform: 'telegram',
            kind: channel ? 'feed-or-community' : 'page',
            exactPost: false,
            channel,
        };
    }

    return { platform: 'other', kind: 'page', exactPost: false };
}
