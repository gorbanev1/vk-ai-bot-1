import { canonicalVkWallUrl } from './eventProvenance.js';

export function selectDeepestCapturedVkWall(value, { maxNodes = 256 } = {}) {
    const visited = new WeakSet();
    const leaves = [];
    let count = 0;
    const visit = (node, depth = 0) => {
        if (!node || typeof node !== 'object' || visited.has(node) || count >= maxNodes || depth > 64) return;
        visited.add(node);
        if (Array.isArray(node)) {
            for (const item of node) visit(item, depth);
            return;
        }
        count += 1;
        const ownerId = Number(node.owner_id ?? node.ownerId ?? node.from_id ?? 0);
        const postId = Number(node.post_id ?? node.postId ?? node.id ?? 0);
        const hasWallIdentity = Number.isSafeInteger(ownerId) && ownerId !== 0 && Number.isSafeInteger(postId) && postId > 0;
        const copies = Array.isArray(node.copy_history) ? node.copy_history : Array.isArray(node.copyHistory) ? node.copyHistory : [];
        if (hasWallIdentity && copies.length === 0) {
            const url = canonicalVkWallUrl(node.url || node.source_url || node.sourceUrl || `https://vk.ru/wall${ownerId}_${postId}`);
            leaves.push({ url, wall: node, depth });
        }
        for (const copy of copies) visit(copy, depth + 1);
        for (const [key, child] of Object.entries(node)) {
            if (/^(?:wall|attachments?|attachment|repost|reposted_message|repostedMessage)$/iu.test(key)) visit(child, depth + 1);
        }
    };
    visit(value);
    return leaves.sort((a, b) => b.depth - a.depth)[0] || null;
}

// Resolve actual copy_history edges, never infer ancestry from the order of
// unrelated links in a post. Each ID is requested once; cycles and limits are
// explicit failures so an incomplete chain cannot be marked processed.
export async function resolveVkOriginalPosts(urls, { fetchWall, signal, maxNodes = 64 } = {}) {
    const nodes = new Map();
    const visiting = new Set();
    async function visit(url, depth = 0) {
        signal?.throwIfAborted();
        const canonical = canonicalVkWallUrl(typeof url === 'object' ? url.url : url);
        if (!canonical) return;
        if (visiting.has(canonical)) throw new Error('VK repost cycle: ' + canonical);
        if (nodes.has(canonical)) {
            nodes.get(canonical).depth = Math.max(nodes.get(canonical).depth, depth);
            return;
        }
        if (nodes.size >= maxNodes) throw new Error('VK repost node limit exceeded');
        visiting.add(canonical);
        const wall = await fetchWall(canonical);
        if (!wall || typeof wall !== 'object') throw new Error('VK original post unavailable: ' + canonical);
        const node = { url: canonical, depth, wall, leaf: true };
        nodes.set(canonical, node);
        for (const copy of Array.isArray(wall.copy_history) ? wall.copy_history : []) {
            const owner = Number(copy.owner_id || copy.from_id);
            const id = Number(copy.id);
            if (!owner || !(id > 0)) continue;
            node.leaf = false;
            await visit(`https://vk.ru/wall${owner}_${id}`, depth + 1);
        }
        visiting.delete(canonical);
    }
    for (const url of urls || []) await visit(url, Number(url?.depth || 0));
    const resolved = [...nodes.values()];
    const original = resolved.filter((node) => node.leaf).sort((a, b) => b.depth - a.depth)[0];
    return { nodes: resolved, originalUrl: original?.url || '', original, repostUrls: resolved.map(({ url, depth }) => ({ url, depth })) };
}
