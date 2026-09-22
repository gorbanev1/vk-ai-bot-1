/**
 * Browser-side staged parsers for modern vk.ru.
 *
 * The functions in this file are intentionally SELF-CONTAINED: Playwright
 * serializes them into page.evaluate(), therefore they must not close over
 * module helpers/imports.
 *
 * Three stages:
 *  1) exact current VK structure observed in saved production pages;
 *  2) tolerant structural variant (stable data-* / partial class semantics);
 *  3) semantic recovery that does not depend on current VK class names.
 */

export function extractVkMessengerDomStaged({ peerId = 0, snapshotHtml = '', baseUrl = 'https://vk.ru/' } = {}) {
    const rootDocument = snapshotHtml ? new DOMParser().parseFromString(String(snapshotHtml), 'text/html') : document;

    const uniq = (values, limit = 100) => {
        const out = [];
        for (const value of values || []) {
            const item = String(value || '').trim();
            if (item && !out.includes(item)) out.push(item);
            if (out.length >= limit) break;
        }
        return out;
    };

    const normalizeText = (value, limit = 12000) => String(value || '')
        .replace(/\r\n?/g, '\n')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, limit);

    const absoluteUrl = (value) => {
        const raw = String(value || '').trim();
        if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return '';
        try {
            return new URL(raw, baseUrl || (typeof location !== 'undefined' ? location.href : 'https://vk.ru/')).href;
        } catch {
            return '';
        }
    };

    const marker = (node) => [
        String(node?.className || ''),
        node?.id || '',
        node?.getAttribute?.('data-testid') || '',
        node?.getAttribute?.('aria-label') || '',
        node?.getAttribute?.('alt') || '',
        node?.getAttribute?.('role') || '',
    ].join(' ').toLowerCase();

    const isUiMarker = (value) => /avatar|profile|authoravatar|userpic|emoji|reaction|sticker|icon|badge|logo|favicon|smile|usersstack/i.test(String(value || ''));
    const isContentMediaMarker = (value) => /photo|media|image|attachment|attach|poster|gallery|picture|thumb|video/i.test(String(value || ''));

    const profileIdFromHref = (value) => {
        const href = String(value || '');
        const direct = href.match(/\/(?:id)(\d+)(?:[/?#]|$)/i);
        if (direct) return Number(direct[1]) || 0;
        const club = href.match(/\/(?:club|public)(\d+)(?:[/?#]|$)/i);
        if (club) return -(Number(club[1]) || 0);
        return 0;
    };

    const numberFrom = (value) => {
        const match = String(value ?? '').match(/(?:^|[^\d])(\d{1,16})(?:$|[^\d])/);
        return match ? Number(match[1]) : 0;
    };

    const wallIdentityFromHref = (value) => {
        const href = String(value || '');
        const match = href.match(/(?:wall|[?&]w=wall)(-?\d+)_(\d+)/i);
        if (!match) return null;
        return {
            ownerId: Number(match[1]),
            postId: Number(match[2]),
            url: `https://vk.ru/wall${Number(match[1])}_${Number(match[2])}`,
        };
    };

    const imageCandidates = (root, { exact = false, owned = false } = {}) => {
        if (!root) return [];
        const found = [];
        let order = 0;

        const add = (value, node, rank = 0) => {
            const url = absoluteUrl(value);
            if (!/^https?:\/\//i.test(url)) return;
            const ownMarker = marker(node);
            if (isUiMarker(ownMarker)) return;
            // Own media never includes an embedded VK post or forwarded message.
            // Aggregate legacy imageUrls remains available for downstream callers.
            if (owned && node?.closest) {
                const nested = node.closest('.AttachWallNew, article.ForwardedMessageNew');
                if (nested && nested !== root) return;
            }

            let context = node;
            let contentContext = false;
            for (let depth = 0; context && depth < 6; depth += 1) {
                const currentMarker = marker(context);
                if (isUiMarker(currentMarker)) return;
                if (isContentMediaMarker(currentMarker)) contentContext = true;
                context = context.parentElement;
            }

            const rect = node?.getBoundingClientRect?.() || { width: 0, height: 0 };
            const width = Math.max(Number(rect.width || 0), Number(node?.getAttribute?.('width') || 0));
            const height = Math.max(Number(rect.height || 0), Number(node?.getAttribute?.('height') || 0));
            const photoAnchor = wallIdentityFromHref(node?.closest?.('a[href]')?.href) ? false : /(?:\bphoto-?\d+_\d+|[?&]z=photo-?\d+_\d+)/i.test(String(node?.closest?.('a[href]')?.href || ''));
            const area = Math.max(0, width * height);
            if (!contentContext && !photoAnchor && area > 0 && area < 180 * 180) return;
            if (exact && !contentContext && !photoAnchor && area < 110 * 110) return;

            const score = rank + (photoAnchor ? 500 : 0) + (contentContext ? 250 : 0) + Math.min(area, 2_000_000) / 10_000;
            found.push({ url, score, order: order += 1 });
        };

        const strong = [
            ...root.querySelectorAll?.('a.AttachPhotos__link img.PhotoItem__img, a[href*="photo"] img, img[data-testid="primary-attachment-image-content"], img.PhotoItem__img') || [],
        ];
        for (const img of strong) {
            for (const value of [img.currentSrc, img.src, img.getAttribute('data-src'), img.getAttribute('data-original')]) {
                add(value, img, 2000);
            }
            for (const entry of String(img.getAttribute('srcset') || '').split(',')) {
                add(entry.trim().split(/\s+/)[0], img, 2000);
            }
        }

        for (const img of root.querySelectorAll?.('img') || []) {
            for (const value of [img.currentSrc, img.src, img.getAttribute('data-src'), img.getAttribute('data-original')]) {
                add(value, img, 200);
            }
            for (const entry of String(img.getAttribute('srcset') || '').split(',')) {
                add(entry.trim().split(/\s+/)[0], img, 200);
            }
        }

        for (const source of root.querySelectorAll?.('picture source[srcset], source[srcset]') || []) {
            for (const entry of String(source.getAttribute('srcset') || '').split(',')) {
                add(entry.trim().split(/\s+/)[0], source, 400);
            }
        }

        for (const styled of root.querySelectorAll?.('[style*="background-image"]') || []) {
            const rect = styled.getBoundingClientRect?.() || { width: 0, height: 0 };
            if (rect.width < 120 && rect.height < 120) continue;
            for (const match of String(styled.getAttribute('style') || '').matchAll(/url\(["']?([^"')]+)["']?\)/gi)) {
                add(match[1], styled, 150);
            }
        }

        const best = new Map();
        for (const item of found) {
            const previous = best.get(item.url);
            if (!previous || item.score > previous.score) best.set(item.url, item);
        }
        return [...best.values()]
            .sort((a, b) => b.score - a.score || a.order - b.order)
            .slice(0, 12)
            .map((item) => item.url);
    };

    const publicLinks = (root) => {
        const walls = [];
        const external = [];
        const media = [];
        for (const anchor of root?.querySelectorAll?.('a[href]') || []) {
            const href = absoluteUrl(anchor.href || anchor.getAttribute('href'));
            if (!href) continue;
            const ownMarker = marker(anchor);
            if (/avatar|profile|author|sender|username|peer/i.test(ownMarker)) continue;
            if (/\/im(?:\/|\?|$)/i.test(new URL(href).pathname + new URL(href).search)) continue;
            const wall = wallIdentityFromHref(href);
            if (wall) {
                walls.push(wall.url);
                continue;
            }
            if (/(?:\bphoto-?\d+_\d+|[?&]z=(?:photo|clip|video))/i.test(href)) media.push(href);
            else external.push(href);
        }
        return uniq([...walls, ...external, ...media], 30);
    };

    const parseRussianDateTime = (dateLabel, timeLabel) => {
        const dateText = normalizeText(dateLabel, 100).toLowerCase();
        const timeMatch = String(timeLabel || '').match(/(?:^|\s)([01]?\d|2[0-3]):([0-5]\d)(?:\s|$)/);
        if (!timeMatch) return 0;

        const now = new Date();
        let year = now.getFullYear();
        let month = now.getMonth();
        let day = now.getDate();
        if (dateText === 'вчера') {
            const previous = new Date(year, month, day - 1);
            year = previous.getFullYear(); month = previous.getMonth(); day = previous.getDate();
        } else if (dateText && dateText !== 'сегодня') {
            const months = {
                'января': 0, 'февраля': 1, 'марта': 2, 'апреля': 3,
                'мая': 4, 'июня': 5, 'июля': 6, 'августа': 7,
                'сентября': 8, 'октября': 9, 'ноября': 10, 'декабря': 11,
            };
            const numeric = dateText.match(/^(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?/);
            const named = dateText.match(/^(\d{1,2})\s+([а-яё]+)(?:\s+(\d{4}))?/i);
            if (numeric) {
                day = Number(numeric[1]); month = Number(numeric[2]) - 1;
                if (numeric[3]) year = Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]);
            } else if (named && Object.hasOwn(months, named[2])) {
                day = Number(named[1]); month = months[named[2]];
                if (named[3]) year = Number(named[3]);
            }
        }
        const local = new Date(year, month, day, Number(timeMatch[1]), Number(timeMatch[2]), 0, 0);
        const value = Math.floor(local.getTime() / 1000);
        return Number.isFinite(value) ? value : 0;
    };

    const readDateLabel = (root) => {
        const stack = root?.closest?.('.ConvoHistory__dateStack') || root?.parentElement;
        const heading = stack?.querySelector?.('.DateSeparator[role="heading"], [role="heading"][aria-label]');
        return normalizeText(heading?.getAttribute?.('aria-label') || heading?.textContent || '', 100);
    };

    const readTimeLabel = (root) => normalizeText(
        root?.querySelector?.('.ConvoMessageInfoWithoutBubbles__date, time, [data-testid*="message_date"], [data-testid*="message_time"]')?.getAttribute?.('datetime') ||
        root?.querySelector?.('.ConvoMessageInfoWithoutBubbles__date, time, [data-testid*="message_date"], [data-testid*="message_time"]')?.textContent || '',
        100,
    );

    const readMessageId = (root) => {
        for (const value of [
            root?.dataset?.itemkey,
            root?.getAttribute?.('data-itemkey'),
            root?.dataset?.cmid,
            root?.getAttribute?.('data-cmid'),
            root?.dataset?.messageId,
            root?.getAttribute?.('data-message-id'),
            root?.dataset?.msgid,
            root?.getAttribute?.('data-msgid'),
            root?.id,
        ]) {
            const number = numberFrom(value);
            if (number > 0) return number;
        }
        let parent = root?.parentElement;
        for (let depth = 0; parent && depth < 6; depth += 1) {
            const number = numberFrom(parent.getAttribute?.('data-itemkey'));
            if (number > 0) return number;
            parent = parent.parentElement;
        }
        return 0;
    };

    const readSender = (root) => {
        for (const value of [
            root?.dataset?.fromId,
            root?.dataset?.senderId,
            root?.dataset?.authorId,
            root?.getAttribute?.('data-from-id'),
            root?.getAttribute?.('data-sender-id'),
            root?.getAttribute?.('data-author-id'),
        ]) {
            const number = Number(value);
            if (Number.isFinite(number) && number !== 0) return { senderId: number, senderUrl: '' };
        }
        const anchor = root?.querySelector?.('.ConvoMessageHeader__authorLink[href], [data-testid*="message_author"][href], header a[href]');
        return {
            senderId: profileIdFromHref(anchor?.href || anchor?.getAttribute?.('href')),
            senderUrl: absoluteUrl(anchor?.href || anchor?.getAttribute?.('href')),
        };
    };

    const directText = (root) => {
        const exact = root?.querySelector?.('.ConvoMessageWithoutBubble__text .MessageText, .ConvoMessageWithoutBubble__text, [data-testid="message_text"], [data-testid*="message_text"]');
        if (exact) return normalizeText(exact.innerText || exact.textContent || '');

        const content = root?.querySelector?.('.ConvoMessageWithoutBubble__content, [data-testid*="message_content"]') || root;
        if (!content) return '';
        const clone = content.cloneNode(true);
        for (const node of clone.querySelectorAll?.([
            '.ConvoMessageHeader', '.ConvoMessageInfoWithoutBubbles',
            '.ConvoMessageWithoutBubble__forwardedMessages', '.ForwardedMessagesList',
            '.ConvoMessageWithoutBubble__attachments', '.Attachments',
            '.ConvoMessageWithoutBubble__reply', '[data-testid="vkme_replied_message"]',
            '.ConvoMessageWithoutBubble__reactions', '[data-testid="vkme_messages_actions"]',
            'button', '[role="button"]',
        ].join(',')) || []) node.remove();
        return normalizeText(clone.innerText || clone.textContent || '');
    };

    const parseWall = (wallNode, depth = 0) => {
        if (!wallNode || depth > 12) return null;
        const canonicalAnchor = [
            ...wallNode.querySelectorAll?.('a[href*="wall"]') || [],
        ].filter((anchor) => {
            const nearestWall = anchor.closest?.('.AttachWallNew');
            return !nearestWall || nearestWall === wallNode;
        }).map((anchor) => ({ anchor, wall: wallIdentityFromHref(anchor.href || anchor.getAttribute('href')) }))
            .find((item) => item.wall && /link--post|post_date|wall/i.test(marker(item.anchor))) ||
            [...wallNode.querySelectorAll?.('a[href*="wall"]') || []]
                .filter((anchor) => {
                    const nearestWall = anchor.closest?.('.AttachWallNew');
                    return !nearestWall || nearestWall === wallNode;
                })
                .map((anchor) => ({ anchor, wall: wallIdentityFromHref(anchor.href || anchor.getAttribute('href')) }))
                .find((item) => item.wall);
        const wall = canonicalAnchor?.wall || null;
        const authorAnchor = wallNode.querySelector?.('.AttachWallNew__authorLink[href], .AttachWallNew__titleLink a[href], header a[href]');
        const authorName = normalizeText(authorAnchor?.innerText || authorAnchor?.textContent || '', 300);
        const authorUrl = absoluteUrl(authorAnchor?.href || authorAnchor?.getAttribute?.('href'));
        const publishedLabel = normalizeText(
            wallNode.querySelector?.('.AttachWallNew__subtitle, time, [data-testid*="date"]')?.innerText ||
            wallNode.querySelector?.('.AttachWallNew__subtitle, time, [data-testid*="date"]')?.textContent || '',
            200,
        );
        const textNode = wallNode.querySelector?.('.AttachWallNew__message, [data-testid*="post_content"], [data-testid*="post-text"]');
        const text = normalizeText(textNode?.innerText || textNode?.textContent || '');
        const ownMedia = imageCandidates(wallNode, { exact: true, owned: true });
        const imageUrls = imageCandidates(wallNode, { exact: true });
        const links = publicLinks(wallNode);
        // A child is nested only when its nearest parent VK-wall is this wall.
        const nestedPosts = [...wallNode.querySelectorAll?.('.AttachWallNew') || []]
            .filter((node) => node !== wallNode && node.parentElement?.closest?.('.AttachWallNew') === wallNode)
            .map((node) => parseWall(node, depth + 1))
            .filter(Boolean);
        return {
            kind: 'wall',
            depth,
            sourceUrl: wall?.url || links.find((url) => wallIdentityFromHref(url)) || '',
            ownerId: wall?.ownerId || 0,
            postId: wall?.postId || 0,
            authorName,
            authorUrl,
            publishedLabel,
            text,
            imageUrls,
            ownMedia,
            nestedPosts,
            links,
        };
    };

    const parseForward = (node, depth = 1) => {
        if (!node || depth > 12) return null;
        const author = node.querySelector?.('.ForwardedMessageNew__userName[href], header a[href], [data-testid*="author"][href]');
        const info = node.querySelector?.('.ForwardedMessageNew__info, time, [data-testid*="date"]');
        const ownContent = node.querySelector?.('.ForwardedMessageNew__content') || node;
        const clone = ownContent.cloneNode(true);
        for (const remove of clone.querySelectorAll?.('.Attachments, .AttachWallNew, .ForwardedMessageNew, button, [role="button"]') || []) remove.remove();
        const text = normalizeText(clone.innerText || clone.textContent || '');
        const walls = [...node.querySelectorAll?.('.AttachWallNew') || []]
            .filter((wall) => !wall.parentElement?.closest?.('.AttachWallNew'))
            .map((wall) => parseWall(wall, depth + 1))
            .filter(Boolean);
        const nested = [...node.querySelectorAll?.(':scope .ForwardedMessagesList__content > article.ForwardedMessageNew, :scope > article.ForwardedMessageNew') || []]
            .filter((child) => child !== node)
            .map((child) => parseForward(child, depth + 1))
            .filter(Boolean);
        return {
            kind: 'forward',
            depth,
            authorName: normalizeText(author?.innerText || author?.textContent || '', 300),
            authorUrl: absoluteUrl(author?.href || author?.getAttribute?.('href')),
            dateLabel: normalizeText(info?.innerText || info?.textContent || '', 200),
            text,
            imageUrls: imageCandidates(node, { exact: true }),
            ownMedia: imageCandidates(node, { exact: true, owned: true }),
            links: publicLinks(node),
            walls,
            forwards: nested,
        };
    };

    const flattenEvidence = (entry, lines, chain) => {
        if (!entry) return;
        if (entry.kind === 'wall') {
            const heading = ['VK wall', entry.authorName, entry.publishedLabel, entry.sourceUrl].filter(Boolean).join(' · ');
            lines.push(`[${heading || 'VK wall'}]`);
            if (entry.text) lines.push(entry.text);
            chain.push(entry);
            for (const nested of entry.nestedPosts || []) flattenEvidence(nested, lines, chain);
            return;
        }
        const heading = ['Пересланное сообщение', entry.authorName, entry.dateLabel].filter(Boolean).join(' · ');
        lines.push(`[${heading}]`);
        if (entry.text) lines.push(entry.text);
        chain.push({
            kind: 'forward', depth: entry.depth, authorName: entry.authorName,
            authorUrl: entry.authorUrl, dateLabel: entry.dateLabel,
        });
        for (const wall of entry.walls || []) flattenEvidence(wall, lines, chain);
        for (const nested of entry.forwards || []) flattenEvidence(nested, lines, chain);
    };

    // The same DOM node can be seen by several contours. Unknown-CMID nodes
    // may be kept within this capture, but never merged by identical text.
    const observedRootIds = new WeakMap();
    let nextObservedRootId = 0;
    const makeLayerTree = (entry, parentLayerId, ordinal = 0) => {
        const isWall = entry.kind === 'wall';
        const postKey = isWall && entry.ownerId && entry.postId
            ? `${entry.ownerId}_${entry.postId}` : '';
        const layerId = `${parentLayerId}/${isWall ? 'post' : 'forward'}:${postKey || ordinal}`;
        const nestedWalls = Array.isArray(entry.nestedPosts) ? entry.nestedPosts : [];
        const forwardedWalls = Array.isArray(entry.walls) ? entry.walls : [];
        const forwards = Array.isArray(entry.forwards) ? entry.forwards : [];
        const children = [...nestedWalls, ...forwardedWalls, ...forwards];
        return {
            layerId, parentLayerId, depth: Number(entry.depth || 0),
            kind: entry.kind, postId: postKey, postUrl: entry.sourceUrl || '',
            ownText: entry.text || '', ownMedia: (entry.ownMedia || []).map((url, mediaIndex) => ({
                url, ownerLayerId: layerId, mediaIndex,
            })),
            relation: 'embedded', relationEvidence: ['nested-vk-dom-container'],
            embeddedPosts: children.map((child, index) => makeLayerTree(child, layerId, index)),
        };
    };

    const parseRoot = (root, stage) => {
        if (!root) return null;
        const conversationMessageId = readMessageId(root);
        if (!observedRootIds.has(root)) observedRootIds.set(root, ++nextObservedRootId);
        const domObservationId = observedRootIds.get(root);
        const parentLayerId = conversationMessageId > 0
            ? `vk-chat:${peerId}:message:${conversationMessageId}`
            : `vk-chat:${peerId}:capture-node:${domObservationId}`;
        const sender = readSender(root);
        const dateLabel = readDateLabel(root);
        const timeLabel = readTimeLabel(root);
        const mainText = directText(root);
        const directWalls = [...root.querySelectorAll?.('.AttachWallNew') || []]
            .filter((wall) => !wall.closest?.('.ForwardedMessageNew') && !wall.parentElement?.closest?.('.AttachWallNew'))
            .map((wall) => parseWall(wall, 1))
            .filter(Boolean);
        const forwardRoots = [...root.querySelectorAll?.('.ForwardedMessagesList__content > article.ForwardedMessageNew') || []]
            .filter((forward) => !forward.parentElement?.closest?.('article.ForwardedMessageNew'))
            .map((forward) => parseForward(forward, 1))
            .filter(Boolean);

        // Stage 2/3: if class names changed, recover wall cards from canonical wall links.
        if (stage >= 2 && !directWalls.length && !forwardRoots.length) {
            const wallAnchors = [...root.querySelectorAll?.('a[href*="wall"]') || []]
                .filter((anchor) => wallIdentityFromHref(anchor.href || anchor.getAttribute('href')));
            for (const anchor of wallAnchors) {
                let node = anchor.parentElement;
                for (let depth = 0; node && node !== root && depth < 8; depth += 1) {
                    const hasText = normalizeText(node.innerText || node.textContent || '').length >= 20;
                    const hasMedia = imageCandidates(node).length > 0;
                    if (hasText || hasMedia) {
                        const parsed = parseWall(node, 1);
                        if (parsed?.sourceUrl && !directWalls.some((item) => item.sourceUrl === parsed.sourceUrl)) {
                            directWalls.push(parsed);
                            break;
                        }
                    }
                    node = node.parentElement;
                }
            }
        }

        const evidenceLines = [];
        const repostChain = [];
        for (const forward of forwardRoots) flattenEvidence(forward, evidenceLines, repostChain);
        for (const wall of directWalls) flattenEvidence(wall, evidenceLines, repostChain);

        const embeddedText = normalizeText(evidenceLines.join('\n\n'), 10000);
        const preferredWallLinks = repostChain
            .filter((item) => item.kind === 'wall' && item.sourceUrl)
            .sort((a, b) => Number(b.depth || 0) - Number(a.depth || 0))
            .map((item) => item.sourceUrl);
        const links = uniq([
            ...preferredWallLinks,
            ...publicLinks(root),
            ...directWalls.flatMap((item) => item.links || []),
            ...forwardRoots.flatMap((item) => item.links || []),
        ], 30);
        const imageUrls = uniq([
            ...directWalls.flatMap((item) => item.imageUrls || []),
            ...forwardRoots.flatMap((item) => item.imageUrls || []),
            ...imageCandidates(root, { exact: stage === 1 }),
        ], 12);

        const fullText = normalizeText([mainText, embeddedText].filter(Boolean).join('\n\n'), 12000);
        if (!conversationMessageId && !fullText && !imageUrls.length && !links.length) return null;

        return {
            sourceKind: 'vk-chat',
            conversationId: String(peerId),
            recordId: conversationMessageId > 0 ? parentLayerId : '',
            identityConfidence: conversationMessageId > 0 ? 'exact' : 'unstable',
            domObservationId,
            conversationMessageId,
            messageId: conversationMessageId > 0 ? String(conversationMessageId) : '',
            ownText: mainText,
            ownMedia: imageCandidates(root, { exact: stage === 1, owned: true })
                .map((url, mediaIndex) => ({ url, ownerLayerId: parentLayerId, mediaIndex })),
            embeddedPosts: [...directWalls, ...forwardRoots]
                .map((entry, index) => makeLayerTree(entry, parentLayerId, index)),
            extractionMethod: stage === 1 ? 'exact' : stage === 2 ? 'adaptive' : 'heuristic',
            senderId: sender.senderId,
            senderUrl: sender.senderUrl,
            createdAt: parseRussianDateTime(dateLabel, timeLabel),
            dateLabel,
            timeLabel,
            text: mainText,
            embeddedText,
            links,
            imageUrls,
            repostChain: repostChain.slice(0, 30),
            parserStage: stage,
        };
    };

    const rootForCandidate = (node) => {
        if (!node) return null;
        const item = node.closest?.('[data-itemkey]');
        if (item) return item;
        return node.closest?.('article') || node;
    };

    const dedupeRoots = (roots) => {
        const out = [];
        const seen = new Set();
        for (const root of roots || []) {
            if (!root || seen.has(root)) continue;
            seen.add(root);
            out.push(root);
        }
        return out;
    };

    const stage1Roots = dedupeRoots([
        ...rootDocument.querySelectorAll('.VirtualScrollItem[data-itemkey]'),
    ].filter((root) => root.querySelector('article.ConvoHistory__messageBlock, .ConvoMessageWithoutBubble')));

    const stage2Roots = dedupeRoots([
        ...rootDocument.querySelectorAll('[data-itemkey]'),
        ...[...rootDocument.querySelectorAll('[data-testid="vkme_messages_actions"], [data-testid^="vkme_message_"]')].map(rootForCandidate),
        ...[...rootDocument.querySelectorAll('article[class*="Message"], article[class*="message"]')].map(rootForCandidate),
    ].filter((root) => {
        if (!root) return false;
        const m = marker(root);
        return Boolean(
            root.getAttribute?.('data-itemkey') ||
            root.querySelector?.('[data-testid="vkme_messages_actions"]') ||
            /message|convo/i.test(m)
        );
    }));

    const semanticCandidates = [];
    const semanticScope = rootDocument.querySelector('[data-scrollbar="content"], [data-scrollbar="scrollable"], [role="main"]') || rootDocument.body;
    for (const article of semanticScope?.querySelectorAll?.('article, [role="listitem"]') || []) {
        const wallLinks = [...article.querySelectorAll?.('a[href*="wall"]') || []].filter((a) => wallIdentityFromHref(a.href || a.getAttribute('href'))).length;
        const photoLinks = article.querySelectorAll?.('a[href*="photo"], img')?.length || 0;
        const actionSignal = article.querySelector?.('[data-testid*="message"], [aria-label*="реакц" i], [aria-label*="ответ" i]');
        const text = normalizeText(article.innerText || article.textContent || '', 2000);
        if (actionSignal || wallLinks || (photoLinks && text.length >= 2)) semanticCandidates.push(rootForCandidate(article));
    }
    const stage3Roots = dedupeRoots(semanticCandidates);

    const parseRoots = (roots, stage) => roots
        .map((root) => parseRoot(root, stage))
        .filter(Boolean)
        .filter((item) => item.text.length >= 2 || item.embeddedText.length >= 2 || item.imageUrls.length || item.links.length);

    const exactMessages = parseRoots(stage1Roots, 1);
    const structuralMessages = parseRoots(stage2Roots, 2);
    const heuristicMessages = parseRoots(stage3Roots, 3);

    // V188.78: all three contours run against the SAME immutable snapshot.
    // Later contours may recover missing records and enrich media/links, but
    // they never replace an exact record with a weaker interpretation.
    const uniqueMessages = new Map();
    const sourceStage = new Map();
    for (const [stageNumber, rows] of [[1, exactMessages], [2, structuralMessages], [3, heuristicMessages]]) {
        for (const item of rows) {
            const key = item.conversationMessageId > 0
                ? `cmid:${item.conversationMessageId}`
                : `capture-node:${item.domObservationId}`;
            const previous = uniqueMessages.get(key);
            if (!previous) {
                uniqueMessages.set(key, { ...item, parserStages: [stageNumber] });
                sourceStage.set(key, stageNumber);
                continue;
            }
            uniqueMessages.set(key, {
                ...previous,
                text: previous.text || item.text,
                embeddedText: previous.embeddedText || item.embeddedText,
                links: uniq([...(previous.links||[]), ...(item.links||[])],30),
                imageUrls: uniq([...(previous.imageUrls||[]), ...(item.imageUrls||[])],12),
                repostChain: previous.repostChain?.length ? previous.repostChain : (item.repostChain || []),
                // Exact ownership wins; later contours only recover fields that were absent.
                ownMedia: previous.ownMedia?.length ? previous.ownMedia : item.ownMedia,
                embeddedPosts: previous.embeddedPosts?.length ? previous.embeddedPosts : item.embeddedPosts,
                parserStages: uniq([...(previous.parserStages||[]).map(String), String(stageNumber)],3).map(Number),
            });
        }
    }
    const recoveredByStructural = [...uniqueMessages.entries()].filter(([key])=>sourceStage.get(key)===2).length;
    const recoveredByHeuristic = [...uniqueMessages.entries()].filter(([key])=>sourceStage.get(key)===3).length;
    const stage = recoveredByHeuristic ? 3 : (recoveredByStructural ? 2 : 1);

    const scrollRoot = rootDocument.querySelector('.ConvoHistory__scrollbar[data-scrollbar="scrollable"]') ||
        rootDocument.querySelector('[data-scrollbar="scrollable"]') || null;
    const numericKeys = [...rootDocument.querySelectorAll('[data-itemkey]')]
        .map((node) => Number(node.getAttribute('data-itemkey')))
        .filter((value) => Number.isSafeInteger(value) && value > 0);

    return {
        stage,
        peerId: Number(peerId) || 0,
        messages: [...uniqueMessages.values()],
        signature: {
            exactRoots: stage1Roots.length,
            flexibleRoots: stage2Roots.length,
            semanticRoots: stage3Roots.length,
            exactParsed: exactMessages.length,
            structuralParsed: structuralMessages.length,
            heuristicParsed: heuristicMessages.length,
            recoveredByStructural,
            recoveredByHeuristic,
            hasExactScrollRoot: Boolean(rootDocument.querySelector('.ConvoHistory__scrollbar[data-scrollbar="scrollable"]')),
            dataItemKeys: numericKeys.length,
            oldestItemKey: numericKeys.length ? Math.min(...numericKeys) : 0,
            newestItemKey: numericKeys.length ? Math.max(...numericKeys) : 0,
            scrollTop: Number(scrollRoot?.scrollTop || 0),
            scrollHeight: Number(scrollRoot?.scrollHeight || 0),
            clientHeight: Number(scrollRoot?.clientHeight || 0),
        },
    };
}

export function extractVkPublicDomStaged({ screenName = '', snapshotHtml = '', baseUrl = 'https://vk.ru/' } = {}) {
    const rootDocument = snapshotHtml ? new DOMParser().parseFromString(String(snapshotHtml), 'text/html') : document;
    const normalizeText = (value, limit = 12000) => String(value || '')
        .replace(/\r\n?/g, '\n')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, limit);

    const uniq = (values, limit = 100) => {
        const out = [];
        for (const value of values || []) {
            const item = String(value || '').trim();
            if (item && !out.includes(item)) out.push(item);
            if (out.length >= limit) break;
        }
        return out;
    };

    const absoluteUrl = (value) => {
        const raw = String(value || '').trim();
        if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return '';
        try { return new URL(raw, baseUrl || location.href).href; } catch { return ''; }
    };

    const parseIdentity = (value) => {
        const raw = String(value || '');
        const match = raw.match(/(?:post|wall)?(-?\d+)[_:](-?\d+)/i) || raw.match(/(?:wall|[?&]w=wall)(-?\d+)_(\d+)/i);
        if (!match) return null;
        const ownerId = Number(match[1]);
        const postId = Math.abs(Number(match[2]));
        if (!Number.isFinite(ownerId) || !postId) return null;
        return { ownerId, postId, key: `${ownerId}_${postId}`, url: `https://vk.ru/wall${ownerId}_${postId}` };
    };

    const marker = (node) => [
        String(node?.className || ''), node?.id || '',
        node?.getAttribute?.('data-testid') || '', node?.getAttribute?.('aria-label') || '',
        node?.getAttribute?.('alt') || '', node?.getAttribute?.('role') || '',
    ].join(' ').toLowerCase();
    const isUiMarker = (value) => /avatar|profile|emoji|reaction|sticker|icon|badge|logo|favicon|smile|userpic|post-header-avatar/i.test(String(value || ''));
    const mediaMarker = (value) => /primary-attachment|photo|media|image|attachment|poster|gallery|picture|thumb/i.test(String(value || ''));

    const collectImages = (root, identity = null) => {
        if (!root) return [];
        const found = [];
        let order = 0;
        const add = (value, node, baseRank = 0) => {
            const url = absoluteUrl(value);
            if (!/^https?:\/\//i.test(url)) return;
            if (isUiMarker(marker(node))) return;
            // Do not let media from a nested repost masquerade as media of the
            // outer post. It will be parsed recursively in repostChain.
            if (identity && node?.closest) {
                const nearestPost = node.closest('[data-testid="post"][data-post-id], [data-post-id]');
                const nearestIdentity = parseIdentity(nearestPost?.getAttribute?.('data-post-id'));
                if (nearestIdentity && nearestIdentity.key !== identity.key) return;
            }
            let current = node;
            let contentContext = false;
            let uiContext = false;
            for (let depth = 0; current && depth < 7; depth += 1) {
                const m = marker(current);
                if (isUiMarker(m)) { uiContext = true; break; }
                if (mediaMarker(m)) contentContext = true;
                current = current.parentElement;
            }
            if (uiContext) return;
            const rect = node?.getBoundingClientRect?.() || { width: 0, height: 0 };
            const width = Math.max(Number(rect.width || 0), Number(node?.getAttribute?.('width') || 0));
            const height = Math.max(Number(rect.height || 0), Number(node?.getAttribute?.('height') || 0));
            const area = Math.max(0, width * height);
            const photoHref = String(node?.closest?.('a[href]')?.href || '');
            const photoLink = /(?:\bphoto-?\d+_\d+|[?&]z=photo-?\d+_\d+)/i.test(photoHref);
            if (!contentContext && !photoLink && area > 0 && area < 180 * 180) return;
            let score = baseRank + (contentContext ? 1000 : 0) + (photoLink ? 900 : 0) + Math.min(area, 4_000_000) / 5000;
            if (width < 120 && height < 120) score -= 5000;
            found.push({ url, score, order: order += 1 });
        };

        // Current VK: this is the real post media, not the group avatar.
        for (const img of root.querySelectorAll?.('img[data-testid="primary-attachment-image-content"]') || []) {
            for (const v of [img.currentSrc, img.src, img.getAttribute('data-src'), img.getAttribute('data-original')]) add(v, img, 10000);
            for (const entry of String(img.getAttribute('srcset') || '').split(',')) add(entry.trim().split(/\s+/)[0], img, 10000);
        }
        for (const img of root.querySelectorAll?.('a[href*="photo"] img, img[class*="Photo"], img[class*="photo"]') || []) {
            for (const v of [img.currentSrc, img.src, img.getAttribute('data-src'), img.getAttribute('data-original')]) add(v, img, 6000);
            for (const entry of String(img.getAttribute('srcset') || '').split(',')) add(entry.trim().split(/\s+/)[0], img, 6000);
        }
        for (const img of root.querySelectorAll?.('img') || []) {
            for (const v of [img.currentSrc, img.src, img.getAttribute('data-src'), img.getAttribute('data-original')]) add(v, img, 100);
            for (const entry of String(img.getAttribute('srcset') || '').split(',')) add(entry.trim().split(/\s+/)[0], img, 100);
            for (const entry of String(img.getAttribute('data-srcset') || '').split(',')) add(entry.trim().split(/\s+/)[0], img, 100);
        }
        for (const source of root.querySelectorAll?.('picture source[srcset], picture source[data-srcset]') || []) {
            for (const entry of String(source.getAttribute('srcset') || '').split(',')) add(entry.trim().split(/\s+/)[0], source, 300);
            for (const entry of String(source.getAttribute('data-srcset') || '').split(',')) add(entry.trim().split(/\s+/)[0], source, 300);
        }
        for (const styled of root.querySelectorAll?.('*') || []) {
            const ownStyle = String(styled.getAttribute?.('style') || '');
            const computedBackground = typeof getComputedStyle === 'function'
                ? String(getComputedStyle(styled).backgroundImage || '')
                : '';
            if (!/url\(/i.test(ownStyle) && !/url\(/i.test(computedBackground)) continue;
            const rect = styled.getBoundingClientRect?.() || { width: 0, height: 0 };
            if (rect.width < 140 && rect.height < 140) continue;
            for (const value of [ownStyle, computedBackground]) {
                for (const match of value.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) add(match[1], styled, 80);
            }
        }

        const best = new Map();
        for (const item of found) {
            const previous = best.get(item.url);
            if (!previous || item.score > previous.score) best.set(item.url, item);
        }
        return [...best.values()]
            .sort((a, b) => b.score - a.score || a.order - b.order)
            .slice(0, 12)
            .map((item) => item.url);
    };

    const readText = (root, identity, stage) => {
        const exact = root.querySelector?.(
            `[data-testid="post-content-container"] [data-testid="showmoretext-in-expanded"], [data-testid="showmoretext-in-expanded"], [data-post-id="${identity?.key || ''}"][id^="text-"]`,
        );
        if (exact) return normalizeText(exact.innerText || exact.textContent || '');
        const tolerant = root.querySelector?.('[data-testid*="showmoretext"], [data-testid*="post_content"], [class*="PostText"], [class*="postText"]');
        if (tolerant) return normalizeText(tolerant.innerText || tolerant.textContent || '');
        if (stage < 3) return '';

        const clone = root.cloneNode(true);
        for (const node of clone.querySelectorAll?.([
            '[data-testid="post-header"]', '[data-testid*="post_footer"]',
            '[data-testid="post_context_menu_toggle"]', '[data-testid*="comment"]',
            'button', '[role="button"]', 'audio', 'video',
        ].join(',')) || []) node.remove();
        return normalizeText(clone.innerText || clone.textContent || '');
    };

    const readPublished = (root, identity) => {
        const time = root.querySelector?.('time[datetime]');
        const parsed = Date.parse(time?.getAttribute?.('datetime') || '');
        if (Number.isFinite(parsed)) return { publishedAt: Math.floor(parsed / 1000), publishedLabel: '' };
        const dateAnchor = root.querySelector?.('[data-testid="post_date_block_preview"]') ||
            [...root.querySelectorAll?.('a[href*="wall"]') || []].find((a) => {
                const id = parseIdentity(a.href || a.getAttribute('href'));
                return id && (!identity || id.key === identity.key) && /date|time|post/i.test(marker(a));
            });
        return {
            publishedAt: 0,
            publishedLabel: normalizeText(
                dateAnchor?.getAttribute?.('aria-label') || dateAnchor?.getAttribute?.('title') || dateAnchor?.innerText || dateAnchor?.textContent || '',
                200,
            ),
        };
    };

    const canonicalIdentity = (root) => {
        for (const attr of [root?.getAttribute?.('data-post-id'), root?.getAttribute?.('data-post'), root?.id]) {
            const parsed = parseIdentity(attr);
            if (parsed) return parsed;
        }
        const links = [...root?.querySelectorAll?.('a[href*="wall"]') || []]
            .filter((anchor) => {
                const nearestPost = anchor.closest?.('[data-testid="post"][data-post-id], [data-post-id]');
                return !nearestPost || nearestPost === root;
            });
        for (const anchor of links) {
            const parsed = parseIdentity(anchor.href || anchor.getAttribute('href'));
            if (!parsed) continue;
            if (/post_date|date_block|post-link|post_link/i.test(marker(anchor))) return parsed;
        }
        return links.map((a) => parseIdentity(a.href || a.getAttribute('href'))).find(Boolean) || null;
    };

    const parsePost = (root, stage, nestingDepth = 0, parentLayerId = '') => {
        const identity = canonicalIdentity(root);
        if (!identity) return null;
        const layerId = parentLayerId
            ? `${parentLayerId}/post:${identity.key}`
            : `vk-public:${String(screenName || '')}:${identity.key}`;
        const published = readPublished(root, identity);
        const text = readText(root, identity, stage);
        const ownNestedRoots = [...root.querySelectorAll?.('[data-testid="post"][data-post-id]') || []]
            .filter((node) => node !== root && node.parentElement?.closest?.('[data-testid="post"][data-post-id]') === root);
        const repostChain = ownNestedRoots
            .map((node) => parsePost(node, Math.max(stage, 1), nestingDepth + 1, layerId))
            .filter(Boolean);
        const ownImageRoot = root;
        const ownImageUrls = collectImages(ownImageRoot, identity);
        let imageUrls = ownImageUrls;
        if (!imageUrls.length && repostChain.length) imageUrls = uniq(repostChain.flatMap((post) => post.imageUrls || []), 12);
        const deepest = repostChain.length
            ? repostChain.reduce((best, current) => {
                const currentDepth = Number(current.repostDepth || 0);
                const bestDepth = Number(best.repostDepth || 0);
                return currentDepth >= bestDepth ? current : best;
            }, repostChain[0])
            : null;
        return {
            sourceKind: 'vk-public',
            recordId: layerId,
            layerId, parentLayerId: parentLayerId || null, depth: nestingDepth,
            ownText: text,
            ownMedia: ownImageUrls.map((url, mediaIndex) => ({ url, ownerLayerId: layerId, mediaIndex })),
            embeddedPosts: repostChain.map((post) => ({
                layerId: post.layerId, parentLayerId: layerId, depth: post.depth,
                postId: `${post.ownerId}_${post.postId}`, postUrl: post.sourceUrl,
                ownText: post.ownText, ownMedia: post.ownMedia,
                embeddedPosts: post.embeddedPosts || [],
                relation: 'embedded', relationEvidence: ['nested-data-post-id'],
            })),
            extractionMethod: stage === 1 ? 'exact' : stage === 2 ? 'adaptive' : 'heuristic',
            screenName: String(screenName || ''),
            ownerId: identity.ownerId,
            postId: identity.postId,
            sourceUrl: identity.url,
            originalSourceUrl: deepest?.originalSourceUrl || deepest?.sourceUrl || '',
            publishedAt: published.publishedAt,
            publishedLabel: published.publishedLabel,
            text,
            imageUrls,
            repostDepth: nestingDepth,
            repostChain: repostChain.map((post) => ({
                ownerId: post.ownerId,
                postId: post.postId,
                sourceUrl: post.sourceUrl,
                originalSourceUrl: post.originalSourceUrl,
                publishedAt: post.publishedAt,
                publishedLabel: post.publishedLabel,
                text: post.text,
                imageUrls: post.imageUrls,
                repostDepth: post.repostDepth,
            })),
            parserStage: stage,
        };
    };

    const exactRoots = [...rootDocument.querySelectorAll('[data-testid="post"][data-post-id]')]
        .filter((node) => {
            const level = Number(node.getAttribute('data-post-nesting-lvl') || 0);
            return level === 0 && !node.parentElement?.closest?.('[data-testid="post"][data-post-id]');
        });

    const flexibleRoots = [];
    for (const node of rootDocument.querySelectorAll('[data-post-id], [data-post]')) {
        const identity = canonicalIdentity(node);
        if (!identity) continue;
        const outer = node.closest?.('article') || node;
        const root = outer.querySelector?.(`[data-post-id="${identity.key}"]`)?.closest?.('[data-post-id]') || node;
        const candidate = root.getAttribute?.('data-testid') === 'post' ? root : (root.closest?.('[data-testid*="post"]') || root);
        if (candidate && !flexibleRoots.includes(candidate)) flexibleRoots.push(candidate);
    }

    const semanticRoots = [];
    for (const article of rootDocument.querySelectorAll('article, [role="article"]')) {
        const wallLinks = [...article.querySelectorAll?.('a[href*="wall"]') || []].filter((a) => parseIdentity(a.href || a.getAttribute('href')));
        if (!wallLinks.length) continue;
        const signalScore = (
            (article.querySelector?.('[data-testid*="post"]') ? 3 : 0) +
            (article.querySelector?.('[data-testid*="attachment"]') ? 2 : 0) +
            (article.querySelector?.('[data-testid*="footer"]') ? 2 : 0) +
            (collectImages(article).length ? 2 : 0) +
            (normalizeText(article.innerText || article.textContent || '').length >= 20 ? 1 : 0)
        );
        if (signalScore >= 3 && !semanticRoots.includes(article)) semanticRoots.push(article);
    }

    const parseRoots = (roots, stage) => {
        const out = [];
        const seen = new Set();
        for (const root of roots) {
            const post = parsePost(root, stage, 0);
            if (!post || seen.has(`${post.ownerId}_${post.postId}`)) continue;
            if (post.text.length < 3 && !post.imageUrls.length) continue;
            seen.add(`${post.ownerId}_${post.postId}`);
            out.push(post);
        }
        return out;
    };

    const exactPosts = parseRoots(exactRoots, 1);
    const structuralPosts = parseRoots(flexibleRoots, 2);
    const heuristicPosts = parseRoots(semanticRoots, 3);
    const merged = new Map();
    const firstStage = new Map();
    for (const [stageNumber, rows] of [[1, exactPosts], [2, structuralPosts], [3, heuristicPosts]]) {
        for (const post of rows) {
            const key = `${post.ownerId}_${post.postId}`;
            const previous = merged.get(key);
            if (!previous) { merged.set(key,{...post,parserStages:[stageNumber]}); firstStage.set(key,stageNumber); continue; }
            merged.set(key,{
                ...previous,
                text: previous.text || post.text,
                publishedAt: previous.publishedAt || post.publishedAt,
                publishedLabel: previous.publishedLabel || post.publishedLabel,
                imageUrls: uniq([...(previous.imageUrls||[]), ...(post.imageUrls||[])],12),
                repostChain: previous.repostChain?.length ? previous.repostChain : (post.repostChain || []),
                ownMedia: previous.ownMedia?.length ? previous.ownMedia : post.ownMedia,
                embeddedPosts: previous.embeddedPosts?.length ? previous.embeddedPosts : post.embeddedPosts,
                parserStages: uniq([...(previous.parserStages||[]).map(String),String(stageNumber)],3).map(Number),
            });
        }
    }
    const posts=[...merged.values()];
    const recoveredByStructural=[...firstStage.values()].filter((value)=>value===2).length;
    const recoveredByHeuristic=[...firstStage.values()].filter((value)=>value===3).length;
    const stage=recoveredByHeuristic?3:(recoveredByStructural?2:1);

    return {
        stage,
        posts,
        signature: {
            exactRoots: exactRoots.length,
            flexibleRoots: flexibleRoots.length,
            semanticRoots: semanticRoots.length,
            exactParsed: exactPosts.length,
            structuralParsed: structuralPosts.length,
            heuristicParsed: heuristicPosts.length,
            recoveredByStructural,
            recoveredByHeuristic,
            dataPostIds: rootDocument.querySelectorAll('[data-post-id]').length,
            primaryAttachmentImages: rootDocument.querySelectorAll('img[data-testid="primary-attachment-image-content"]').length,
            postDateBlocks: rootDocument.querySelectorAll('[data-testid="post_date_block_preview"]').length,
        },
    };
}
