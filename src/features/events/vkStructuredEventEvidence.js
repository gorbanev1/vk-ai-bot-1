const VK_EVENT_TIME_ZONE = 'Europe/Moscow';

function cleanText(value, maximum = 12000) {
    return String(value ?? '')
        .replace(/\u00a0/gu, ' ')
        .replace(/[ \t]+/gu, ' ')
        .replace(/\n{3,}/gu, '\n\n')
        .trim()
        .slice(0, maximum);
}



function readBalancedJsonLiteral(source, startIndex) {
    const text = String(source ?? '');
    let start = -1;
    for (let index = Math.max(0, Number(startIndex) || 0); index < text.length; index += 1) {
        const char = text[index];
        if (char === '[' || char === '{') {
            start = index;
            break;
        }
        if (!/[\s:=]/u.test(char)) return '';
    }
    if (start < 0) return '';

    const stack = [];
    let quote = '';
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
        const char = text[index];
        if (quote) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === '\\') {
                escaped = true;
                continue;
            }
            if (char === quote) quote = '';
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === '[' || char === '{') {
            stack.push(char);
            continue;
        }
        if (char === ']' || char === '}') {
            const expected = char === ']' ? '[' : '{';
            if (stack.at(-1) !== expected) return '';
            stack.pop();
            if (!stack.length) return text.slice(start, index + 1);
        }
    }
    return '';
}

/**
 * Reads JSON-shaped VK bootstrap payloads from the original HTML without
 * executing page scripts. `apiPrefetchCache` is the preferred VK signal, but
 * JSON script blocks are also accepted so this does not depend on one exact
 * markup/template revision.
 */
export function extractVkStructuredBootstrapSourcesFromHtml(html, {
    maximum = 120,
} = {}) {
    const source = String(html ?? '');
    const result = [];
    const safeMaximum = Math.max(1, Math.min(500, Number(maximum) || 120));
    const addParsed = (value) => {
        if (!value || typeof value !== 'object' || result.length >= safeMaximum) return;
        result.push(value);
    };

    const marker = /\bapiPrefetchCache\b\s*=/giu;
    let match;
    while ((match = marker.exec(source)) !== null && result.length < safeMaximum) {
        const literal = readBalancedJsonLiteral(source, marker.lastIndex);
        if (!literal) continue;
        try {
            addParsed(JSON.parse(literal));
        } catch {
            // VK may change the assignment to non-JSON JavaScript. Runtime
            // capture remains available; generic DOM/page parsing is the final
            // fallback, so never execute arbitrary script text here.
        }
    }

    // Generic JSON bootstrap fallback used by some SPA/SSR revisions.
    const scriptPattern = /<script\b[^>]*type=(?:"application\/json"|'application\/json')[^>]*>([\s\S]*?)<\/script>/giu;
    while ((match = scriptPattern.exec(source)) !== null && result.length < safeMaximum) {
        const body = String(match[1] ?? '').trim();
        if (!body || body.length > 4 * 1024 * 1024) continue;
        if (!/(?:start[_-]?date|startDate|isEvent|"type"\s*:\s*"event")/u.test(body)) continue;
        try {
            addParsed(JSON.parse(body));
        } catch {
            // Ignore malformed/non-JSON script blocks.
        }
    }

    return result;
}

function normalizeKey(value) {
    return String(value ?? '')
        .replace(/[^a-z0-9]/giu, '')
        .toLowerCase();
}

function firstField(object, names) {
    if (!object || typeof object !== 'object') return undefined;
    const wanted = new Set(names.map(normalizeKey));
    for (const [key, value] of Object.entries(object)) {
        if (wanted.has(normalizeKey(key))) return value;
    }
    return undefined;
}

function unixSeconds(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return 0;
    if (numeric > 10_000_000_000) return Math.floor(numeric / 1000);
    return Math.floor(numeric);
}

function truthyFlag(value) {
    if (value === true || value === 1) return true;
    return /^(?:1|true|yes|event)$/iu.test(String(value ?? '').trim());
}

function stringifyLocation(value) {
    if (!value) return '';
    if (typeof value === 'string' || typeof value === 'number') return cleanText(value, 600);
    if (Array.isArray(value)) {
        return value.map(stringifyLocation).filter(Boolean).join(', ').slice(0, 600);
    }
    if (typeof value !== 'object') return '';
    const ordered = [
        firstField(value, ['title', 'name']),
        firstField(value, ['address', 'street']),
        firstField(value, ['city', 'city_name']),
        firstField(value, ['place']),
    ].map((item) => (
        item && typeof item === 'object'
            ? stringifyLocation(item)
            : cleanText(item, 250)
    )).filter(Boolean);
    return [...new Set(ordered)].join(', ').slice(0, 600);
}


function cleanStructuredScalar(value, maximum = 600) {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number') {
        return cleanText(value, maximum);
    }
    return '';
}

function readStructuredCity(value) {
    if (!value) return '';
    if (typeof value === 'string' || typeof value === 'number') return cleanText(value, 250);
    if (typeof value !== 'object' || Array.isArray(value)) return '';
    return cleanStructuredScalar(firstField(value, ['title', 'name', 'city_name', 'cityName']), 250);
}

function resolveStructuredEventLocation(object) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) {
        return { venue: '', address: '', city: '' };
    }

    const addresses = firstField(object, ['addresses']);
    const mainAddress = addresses && typeof addresses === 'object' && !Array.isArray(addresses)
        ? firstField(addresses, ['main_address', 'mainAddress'])
        : null;
    const directVenueValue = firstField(object, ['venue', 'place', 'location']);
    const directAddressValue = firstField(object, ['address']);

    const directVenue = stringifyLocation(directVenueValue);
    const mainVenue = mainAddress && typeof mainAddress === 'object'
        ? cleanStructuredScalar(firstField(mainAddress, ['title', 'name']), 300)
        : '';
    const directAddress = stringifyLocation(directAddressValue);
    const mainStreet = mainAddress && typeof mainAddress === 'object'
        ? cleanStructuredScalar(firstField(mainAddress, ['address', 'street']), 350)
        : '';
    const city = readStructuredCity(
        mainAddress && typeof mainAddress === 'object'
            ? firstField(mainAddress, ['city'])
            : null,
    ) || readStructuredCity(firstField(object, ['city']));

    // VK event groups frequently expose both city and addresses.main_address.
    // The concrete place title must win over the generic city; otherwise a
    // perfectly useful "Котельная" becomes just "Воронеж".
    const venue = directVenue || mainVenue || directAddress || city;
    const addressParts = [mainStreet, city]
        .map((item) => cleanText(item, 350))
        .filter(Boolean);
    const address = [...new Set(addressParts)].join(', ').slice(0, 600);

    return { venue, address, city };
}

function looksLikeHttpImage(value) {
    const source = String(value ?? '').trim();
    return /^https?:\/\//iu.test(source) && /(?:userapi|vkuseraudio|\.jpe?g(?:\?|$)|\.png(?:\?|$)|\.webp(?:\?|$)|photo|image|cover)/iu.test(source);
}

function collectImageUrls(root, maximum = 8) {
    const result = [];
    const seen = new WeakSet();
    const visit = (value, depth = 0, parentKey = '') => {
        if (result.length >= maximum || value == null || depth > 6) return;
        if (typeof value === 'string') {
            if (looksLikeHttpImage(value) && /(?:photo|image|cover|url|src|thumb|avatar)/iu.test(parentKey)) {
                result.push(value.trim());
            }
            return;
        }
        if (typeof value !== 'object') return;
        if (seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) {
            for (const item of value) visit(item, depth + 1, parentKey);
            return;
        }
        for (const [key, child] of Object.entries(value)) {
            const normalized = normalizeKey(key);
            if (/^(?:cover|images?|photos?|photo\d*|photo|origphoto|cropphoto|sizes|thumb|avatar|url|src|maxsizeurl)$/u.test(normalized) || depth <= 1) {
                visit(child, depth + 1, key);
            }
        }
    };
    visit(root);
    const ranked = [...new Set(result)].map((url, index) => {
        let area = 0;
        try {
            const size = new URL(url).searchParams.get('size') || '';
            const match = size.match(/^(\d+)x(\d+)$/u);
            if (match) area = Number(match[1]) * Number(match[2]);
        } catch {}
        return { url, area, index };
    }).sort((left, right) => right.area - left.area || left.index - right.index);

    // VK often exposes the same cover in 5 resolutions. Prefer the largest
    // variants so vision does not waste slots on tiny duplicates.
    const byPath = new Map();
    for (const item of ranked) {
        let key = item.url;
        try {
            const parsed = new URL(item.url);
            for (const name of ['size', 'cs', 'quality', 'crop']) parsed.searchParams.delete(name);
            key = `${parsed.origin}${parsed.pathname}`;
        } catch {}
        if (!byPath.has(key)) byPath.set(key, item.url);
    }
    return [...byPath.values()].slice(0, maximum);
}

function cleanVkWallMarkupText(value) {
    return cleanText(value, 20_000)
        .replace(/\[#alias\|([^|\]]+)\|([^\]]+)\]/giu, '$1 ($2)')
        .replace(/\[(?:id|club|public|event)-?\d+\|([^\]]+)\]/giu, '$1');
}

function collectVkWallTextRecursive(wall, { maxDepth = 4, maximum = 30_000 } = {}) {
    const blocks = [];
    const seen = new WeakSet();
    const visit = (item, depth = 0) => {
        if (!item || typeof item !== 'object' || depth > maxDepth || seen.has(item)) return;
        seen.add(item);
        const text = cleanVkWallMarkupText(item?.text || '');
        if (text) blocks.push(depth > 0 ? `[REPOST ${depth}]\n${text}` : text);
        if (depth >= maxDepth) return;
        for (const copy of Array.isArray(item?.copy_history) ? item.copy_history : []) {
            visit(copy, depth + 1);
        }
    };
    visit(wall, 0);
    return blocks.join('\n\n').trim().slice(0, maximum);
}

function chooseLargestVkPhotoUrl(photo) {
    if (!photo || typeof photo !== 'object') return '';
    const variants = [];
    const add = (url, width = 0, height = 0) => {
        const clean = String(url ?? '').trim();
        if (!/^https?:\/\//iu.test(clean)) return;
        variants.push({
            url: clean,
            area: Math.max(0, Number(width) || 0) * Math.max(0, Number(height) || 0),
        });
    };
    for (const size of Array.isArray(photo.sizes) ? photo.sizes : []) {
        add(size?.url || size?.src, size?.width, size?.height);
    }
    add(
        photo?.orig_photo?.url,
        photo?.orig_photo?.width || photo?.width,
        photo?.orig_photo?.height || photo?.height,
    );
    add(photo?.max_size_url, photo?.width, photo?.height);
    variants.sort((left, right) => right.area - left.area);
    return variants[0]?.url || '';
}

function collectVkWallPhotoUrls(wall, maximum = 4) {
    const urls = [];
    const visit = (item, depth = 0) => {
        if (!item || typeof item !== 'object' || depth > 4) return;
        for (const attachment of Array.isArray(item?.attachments) ? item.attachments : []) {
            if (String(attachment?.type || '').toLowerCase() !== 'photo') continue;
            const url = chooseLargestVkPhotoUrl(attachment?.photo || attachment);
            if (url) urls.push(url);
        }
        for (const copy of Array.isArray(item?.copy_history) ? item.copy_history : []) {
            visit(copy, depth + 1);
        }
    };
    visit(wall);
    return [...new Set(urls)].slice(0, Math.max(1, Math.min(12, Number(maximum) || 4)));
}

function parseExactWallTarget(value) {
    const match = String(value ?? '').match(/wall(-?\d+)_(\d+)/iu);
    if (!match) return null;
    return {
        ownerId: Number(match[1]) || 0,
        postId: Number(match[2]) || 0,
    };
}

/**
 * Extract the exact wall post from any captured VK bootstrap source.
 *
 * This is deliberately source-shape tolerant: it searches for wall.getById
 * entries recursively instead of relying on one fixed script/template. The
 * returned wall timestamp is crucial evidence for yearless dates such as
 * "19 сентября".
 */
export function extractVkExactWallPostsFromBootstrap(sources, {
    sourceUrl = '',
    maximum = 8,
} = {}) {
    const target = parseExactWallTarget(sourceUrl);
    const roots = Array.isArray(sources) ? sources : [sources];
    const result = [];
    const visited = new WeakSet();
    const safeMaximum = Math.max(1, Math.min(40, Number(maximum) || 8));

    const addWall = (wall, response = {}) => {
        if (!wall || typeof wall !== 'object' || result.length >= safeMaximum) return;
        const ownerId = Number(wall?.owner_id ?? wall?.from_id ?? 0) || 0;
        const postId = Number(wall?.id ?? 0) || 0;
        if (!ownerId || !postId) return;
        if (target && (ownerId !== target.ownerId || postId !== target.postId)) return;

        const ownerGroup = (Array.isArray(response?.groups) ? response.groups : [])
            .find((group) => Number(group?.id || 0) === Math.abs(ownerId)) || null;
        const ownerIsEvent = String(ownerGroup?.type || '').toLowerCase() === 'event';
        const eventTitle = ownerIsEvent ? cleanText(ownerGroup?.name, 700) : '';
        const wallText = collectVkWallTextRecursive(wall, { maxDepth: 4 });
        const eventPagePath = ownerIsEvent
            ? String(ownerGroup?.url || ownerGroup?.screen_name || `event${Math.abs(ownerId)}`).trim()
            : '';
        const eventPageUrl = eventPagePath
            ? /^https?:\/\//iu.test(eventPagePath)
                ? eventPagePath
                : `https://vk.ru/${eventPagePath.replace(/^\/+/u, '')}`
            : '';
        const imageUrls = collectVkWallPhotoUrls(wall);

        result.push({
            index: 0,
            id: `wall${ownerId}_${postId}`,
            ownerId,
            postId,
            text: wallText,
            rawWallText: wallText,
            eventTitle,
            imageUrls,
            links: [`https://vk.ru/wall${ownerId}_${postId}`],
            sourceUrl: `https://vk.ru/wall${ownerId}_${postId}`,
            publishedAt: Number(wall?.date || 0),
            publishedAtSource: 'vk-raw-html-prefetch-wall-date-v18811',
            matchesSourceUrl: !target || (ownerId === target.ownerId && postId === target.postId),
            extractionMethod: 'exact-bootstrap-vk-api-prefetch-raw-html',
            imageConfidence: imageUrls.length ? 'wall-photo' : 'none',
            ownerGroupType: String(ownerGroup?.type || ''),
            eventPageUrl,
        });
    };

    const walk = (value, depth = 0) => {
        if (value == null || depth > 14 || result.length >= safeMaximum) return;
        if (typeof value !== 'object') return;
        if (visited.has(value)) return;
        visited.add(value);

        if (Array.isArray(value)) {
            for (const item of value) walk(item, depth + 1);
            return;
        }

        const method = String(firstField(value, ['method', 'api_method', 'apiMethod']) || '');
        if (normalizeKey(method) === 'wallgetbyid') {
            const response = value?.response;
            const items = Array.isArray(response?.items)
                ? response.items
                : Array.isArray(response)
                    ? response
                    : [];
            for (const wall of items) addWall(wall, response);
        }

        for (const child of Object.values(value)) {
            if (child && typeof child === 'object') walk(child, depth + 1);
        }
    };

    for (const root of roots) walk(root, 0);

    const deduped = new Map();
    for (const post of result) {
        const key = `${post.ownerId}_${post.postId}`;
        const previous = deduped.get(key);
        if (!previous || Number(post.publishedAt || 0) > Number(previous.publishedAt || 0)) {
            deduped.set(key, post);
        }
    }
    return [...deduped.values()].slice(0, safeMaximum);
}

function candidateFromObject(object, context = {}) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) return null;

    const startAt = unixSeconds(firstField(object, [
        'start_date', 'startDate', 'starts_at', 'startsAt', 'start_time', 'startTime', 'event_start', 'eventStart',
    ]));
    if (!startAt) return null;

    const finishAt = unixSeconds(firstField(object, [
        'finish_date', 'finishDate', 'end_date', 'endDate', 'ends_at', 'endsAt', 'finish_time', 'finishTime', 'event_end', 'eventEnd',
    ]));
    const type = cleanText(firstField(object, ['type', 'object_type', 'objectType', 'entity_type', 'entityType']), 80).toLowerCase();
    const isEvent = truthyFlag(firstField(object, ['is_event', 'isEvent', 'event']));
    const title = cleanText(firstField(object, ['name', 'title', 'event_name', 'eventName']), 700);
    const description = cleanText(firstField(object, ['description', 'text', 'about']), 8000);
    const status = cleanText(firstField(object, ['status', 'subtitle']), 1000);
    const id = Number(firstField(object, ['id', 'group_id', 'groupId', 'event_id', 'eventId'])) || 0;
    const location = resolveStructuredEventLocation(object);
    const venue = location.venue;

    let score = 20;
    if (type === 'event' || /(?:^|[_-])event(?:$|[_-])/iu.test(type)) score += 18;
    if (isEvent) score += 18;
    if (title) score += 6;
    if (description || status) score += 2;
    if (finishAt) score += 2;
    if (/groups?getbyid|event|community/iu.test(String(context.method || context.path || ''))) score += 7;

    // A generic object that merely happens to expose startDate should not beat
    // a real VK event. At least one semantic event signal is required unless
    // it came from a group/event API payload and has a name.
    const semanticEvent = type === 'event' || isEvent || /event/iu.test(String(context.method || context.path || ''));
    const groupApiEvent = /groups?getbyid|community/iu.test(String(context.method || context.path || '')) && title;
    if (!semanticEvent && !groupApiEvent) return null;

    return {
        id,
        title,
        description,
        status,
        venue,
        address: location.address,
        city: location.city,
        startAt,
        finishAt,
        type: type || (isEvent ? 'event' : ''),
        imageUrls: collectImageUrls(object),
        sourceMethod: cleanText(context.method || context.path || 'vk-structured-bootstrap', 240),
        score,
    };
}

export function extractVkStructuredEventsFromBootstrap(sources, { maximum = 8 } = {}) {
    const roots = Array.isArray(sources) ? sources : [sources];
    const candidates = [];
    const visited = new WeakSet();
    let objectCount = 0;
    const maxObjects = 25_000;

    const walk = (value, context = {}, depth = 0) => {
        if (value == null || depth > 14 || objectCount >= maxObjects) return;
        if (typeof value !== 'object') return;
        if (visited.has(value)) return;
        visited.add(value);
        objectCount += 1;

        if (Array.isArray(value)) {
            for (let index = 0; index < value.length; index += 1) {
                walk(value[index], { ...context, path: `${context.path || 'root'}[${index}]` }, depth + 1);
            }
            return;
        }

        const method = cleanText(firstField(value, ['method', 'api_method', 'apiMethod']), 160) || context.method || '';
        const path = context.path || 'root';
        const candidate = candidateFromObject(value, { method, path });
        if (candidate) candidates.push(candidate);

        for (const [key, child] of Object.entries(value)) {
            if (child == null || typeof child !== 'object') continue;
            walk(child, {
                method,
                path: `${path}.${key}`,
            }, depth + 1);
        }
    };

    roots.forEach((root, index) => walk(root, { path: `source[${index}]` }, 0));

    const deduped = new Map();
    for (const candidate of candidates) {
        const key = `${candidate.id || 0}|${candidate.startAt}|${candidate.title.toLowerCase()}`;
        const previous = deduped.get(key);
        if (!previous || candidate.score > previous.score) deduped.set(key, candidate);
    }

    return [...deduped.values()]
        .sort((left, right) => right.score - left.score || left.startAt - right.startAt)
        .slice(0, Math.max(1, Math.min(40, Number(maximum) || 8)));
}

function zonedParts(unixTimestamp, timeZone = VK_EVENT_TIME_ZONE) {
    const date = new Date(Number(unixTimestamp || 0) * 1000);
    if (!Number.isFinite(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    if (!map.year || !map.month || !map.day) return null;
    return {
        isoDate: `${map.year}-${map.month}-${map.day}`,
        humanDate: `${map.day}.${map.month}.${map.year}`,
        time: map.hour && map.minute ? `${map.hour}:${map.minute}` : '',
    };
}

export function formatVkStructuredEventEvidence(event, {
    timeZone = VK_EVENT_TIME_ZONE,
} = {}) {
    const parts = zonedParts(event?.startAt, timeZone);
    const lines = [];
    if (event?.title) lines.push(`Название: ${cleanText(event.title, 700)}`);
    if (parts?.humanDate) lines.push(`Дата: ${parts.humanDate}`);
    if (parts?.time) lines.push(`Время: ${parts.time}`);
    if (event?.venue) lines.push(`Место: ${cleanText(event.venue, 700)}`);
    if (event?.address && !String(event.address).includes(String(event.venue || ''))) {
        lines.push(`Адрес: ${cleanText(event.address, 700)}`);
    }
    if (event?.description) lines.push(`Описание: ${cleanText(event.description, 8000)}`);
    if (event?.status && !String(event.status).includes(String(event.description || ''))) {
        lines.push(`Статус: ${cleanText(event.status, 1200)}`);
    }
    return {
        text: lines.join('\n').trim(),
        eventDate: parts?.isoDate || '',
        eventTime: parts?.time || '',
    };
}
