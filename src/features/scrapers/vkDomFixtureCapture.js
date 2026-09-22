/**
 * V188.138: immutable, selector-free VK DOM input for repeatable offline parsing.
 * No post extraction, admission, network fetch, scrolling or AI happens here.
 * Every capture reads HTML and browser state inside ONE page.evaluate invocation.
 */
import fs from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join, relative } from 'node:path';

const sha256 = (body) => createHash('sha256').update(body).digest('hex');
const iso = () => new Date().toISOString();
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

async function atomicWrite(target, bytes) {
    const temp = `${target}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    try {
        await fs.writeFile(temp, bytes, { flag: 'wx' });
        await fs.rename(temp, target);
    } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => {});
        throw error;
    }
}

export async function readVkBrowserDom(page, { includeStructure = false } = {}) {
    if (!page || typeof page.evaluate !== 'function' || page.isClosed?.()) {
        throw new Error('VK DOM fixture: browser page is not available');
    }
    return page.evaluate(({ includeStructure }) => {
        const root = document.documentElement;
        if (!root) throw new Error('VK DOM fixture: documentElement is missing');
        const html = root.outerHTML;
        const nodes = Array.from(document.querySelectorAll('*'));
        const indexByNode = new Map(nodes.map((node, index) => [node, index]));
        const attributes = (node) => Object.fromEntries(
            Array.from(node?.attributes || [], (attr) => [attr.name, attr.value]),
        );
        const elementIndex = (node) => indexByNode.get(node) ?? null;
        const media = [];
        const stateful = [];
        for (const node of nodes) {
            const tag = node.tagName.toLowerCase();
            const index = elementIndex(node);
            if (node.matches('a[href], img, source, picture, video, audio, iframe, link[href], [src], [srcset], [data-src], [data-srcset], [data-original], [data-image]')) {
                const item = { elementIndex: index, tag, attributes: attributes(node) };
                if (node instanceof HTMLImageElement) {
                    item.currentSrc = node.currentSrc || '';
                    item.naturalWidth = node.naturalWidth;
                    item.naturalHeight = node.naturalHeight;
                    item.complete = node.complete;
                }
                if (node instanceof HTMLVideoElement) item.currentSrc = node.currentSrc || '';
                if (node.href) item.resolvedHref = String(node.href);
                if (node.src) item.resolvedSrc = String(node.src);
                media.push(item);
            }
            // Runtime form properties are not necessarily reflected in outerHTML.
            if (node instanceof HTMLInputElement) {
                stateful.push({ elementIndex: index, tag, value: node.value, checked: node.checked, selected: node.selected });
            } else if (node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) {
                stateful.push({ elementIndex: index, tag, value: node.value, selectedIndex: node.selectedIndex ?? null });
            } else if (node.scrollTop || node.scrollLeft) {
                stateful.push({ elementIndex: index, tag, scrollTop: node.scrollTop, scrollLeft: node.scrollLeft });
            }
            if (node.shadowRoot) {
                stateful.push({ elementIndex: index, tag, openShadowHtml: node.shadowRoot.innerHTML });
            }
            if (tag === 'iframe') {
                try {
                    const frame = node.contentDocument;
                    stateful.push({ elementIndex: index, tag, iframeAccessible: Boolean(frame),
                        iframeHtml: frame?.documentElement?.outerHTML ?? null,
                        iframeBaseUri: frame?.baseURI ?? null });
                } catch (error) {
                    stateful.push({ elementIndex: index, tag, iframeAccessible: false,
                        iframeError: String(error?.message || error) });
                }
            }
        }
        // CSS background resources do not appear in src/srcset. A separate runtime
        // record is necessary; the original DOM above is never modified.
        for (const node of nodes) {
            const style = getComputedStyle(node);
            const backgroundImage = style.backgroundImage;
            if (backgroundImage && backgroundImage !== 'none') {
                media.push({ elementIndex: elementIndex(node), tag: node.tagName.toLowerCase(),
                    kind: 'computed-background', backgroundImage });
            }
        }
        const doctype = document.doctype ? {
            name: document.doctype.name, publicId: document.doctype.publicId,
            systemId: document.doctype.systemId,
        } : null;
        // Advisory structure is stored separately from the canonical raw HTML.
        // It is deliberately selector-free and never asserts a post/template.
        const structure = includeStructure ? (() => {
            const elements = nodes.map((node, index) => {
                const parentIndex = indexByNode.get(node.parentElement) ?? null;
                const directTextNodes = Array.from(node.childNodes)
                    .map((child, childIndex) => child.nodeType === Node.TEXT_NODE
                        ? { childIndex, text: child.nodeValue } : null)
                    .filter(Boolean);
                return { index, parentIndex, tag: node.tagName.toLowerCase(),
                    siblingIndex: node.parentElement
                        ? Array.prototype.indexOf.call(node.parentElement.children, node) : 0,
                    attributes: attributes(node), directTextNodes };
            });
            // A wall link is evidence of a possible publication, NOT a confirmed
            // card root. Preserve the ancestor chain for independent offline review.
            const anchors = nodes.filter((node) => node.tagName === 'A' &&
                /(?:^|\/)wall-?\d+_\d+/iu.test(node.getAttribute('href') || node.href || ''));
            const postLinkCandidates = anchors.map((anchor) => {
                const ancestors = [];
                let cursor = anchor;
                for (let depth = 0; cursor && depth < 9; depth += 1, cursor = cursor.parentElement) {
                    ancestors.push({ elementIndex: indexByNode.get(cursor) ?? null,
                        tag: cursor.tagName.toLowerCase(),
                        className: cursor.getAttribute('class') || '',
                        id: cursor.id || '',
                        dataPostId: cursor.getAttribute('data-post-id') || '',
                        childElementCount: cursor.children.length,
                        totalElementCount: cursor.querySelectorAll('*').length,
                        textChars: cursor.textContent?.length || 0,
                        imageCount: cursor.querySelectorAll('img').length });
                }
                return { anchorElementIndex: indexByNode.get(anchor) ?? null,
                    href: anchor.getAttribute('href'), resolvedHref: anchor.href,
                    ancestors, verifiedCardRoot: false };
            });
            // Build a conservative selector contract from this exact DOM.
            // The contract is evidence (counts + selectors), never parser output:
            // selectors are retained only when they match real nodes in this
            // snapshot and identify a wall/post identity.
            const selectorCandidates = {
                postRoot: [
                    '[data-testid="post"][data-post-id]',
                    '[data-testid*="post"][data-post-id]',
                    'article[data-post-id]',
                    '[role="article"][data-post-id]',
                ],
                content: [
                    '[data-testid="post-content-container"]',
                    '[data-testid*="post-content"]',
                    '[class*="post-content-container"]',
                ],
                image: [
                    'img[data-testid="primary-attachment-image-content"]',
                    'img[class*="primary-attachment-image-content"]',
                    '[data-testid*="attachment"] img',
                    '[class*="primary-attachment"] img',
                ],
                published: [
                    '[data-testid="post_date_block_preview"]',
                    '[data-testid*="post_date"]',
                    'time[datetime]',
                ],
            };
            const selectorContract = Object.fromEntries(Object.entries(selectorCandidates).map(([field, candidates]) => {
                const observations = candidates.map((selector) => {
                    let matches = [];
                    try { matches = Array.from(document.querySelectorAll(selector)); } catch { matches = []; }
                    const identityMatches = field === 'postRoot'
                        ? matches.filter((node) => /(?:^|[_:-])-?\d+[_:]\d+$/u.test(node.getAttribute('data-post-id') || ''))
                        : matches;
                    return { selector, count: matches.length, identityCount: identityMatches.length };
                });
                const selected = observations.find((item) => field === 'postRoot'
                    ? item.identityCount > 0
                    : item.count > 0) || null;
                return [field, { selected: selected?.selector || '', observations,
                    evidence: selected ? 'observed-in-baseline-dom' : 'absent-in-baseline-dom' }];
            }));
            return { schemaVersion: 1, canonicalInput: 'dom.raw.html',
                notice: 'Candidate links and ancestor chains are hints, not parser output or verified post-card templates.',
                nodeCount: elements.length, elements, postLinkCandidates, selectorContract };
        })() : null;
        return {
            html,
            structure,
            capturedAt: new Date().toISOString(),
            state: { pageUrl: location.href, baseUri: document.baseURI, title: document.title,
                language: root.lang, direction: root.dir, doctype,
                scrollX: window.scrollX, scrollY: window.scrollY,
                viewport: { width: window.innerWidth, height: window.innerHeight },
                devicePixelRatio: window.devicePixelRatio,
                scrollHeight: Math.max(root.scrollHeight, document.body?.scrollHeight || 0),
                documentWidth: root.scrollWidth, documentHeight: root.scrollHeight,
                visibleState: document.visibilityState, statefulElements: stateful,
                elementIndexMeaning: 'zero-based document.querySelectorAll(*) at capture time',
            },
            resources: media,
        };
    }, { includeStructure });
}

/** Wait for a short DOM quiet interval; no scroll/navigation/networkidle. */
export async function waitForVkStructureQuiet(page, { quietMs = 600, maxWaitMs = 4500 } = {}) {
    if (!page || typeof page.evaluate !== 'function' || page.isClosed?.()) {
        throw new Error('VK DOM baseline: browser page is not available');
    }
    return page.evaluate(({ quietMs, maxWaitMs }) => new Promise((resolve) => {
        const started = performance.now();
        let lastMutation = started;
        const observer = new MutationObserver(() => { lastMutation = performance.now(); });
        observer.observe(document.documentElement, { subtree: true, childList: true,
            characterData: true, attributes: true });
        const check = () => {
            const elapsed = performance.now() - started;
            if (performance.now() - lastMutation >= quietMs || elapsed >= maxWaitMs) {
                const stable = performance.now() - lastMutation >= quietMs;
                observer.disconnect();
                resolve({ stable, waitedMs: Math.round(elapsed), quietMs, maxWaitMs,
                    reason: stable ? 'dom-quiet' : 'quiet-timeout' });
            } else setTimeout(check, 100);
        };
        check();
    }), { quietMs, maxWaitMs });
}

/** Provides one snapshot per actual scraper observation; it NEVER scrolls itself. */
export function createVkDomFixtureCapture({ runDirectory, runId, onPersist = null }) {
    const sources = new Map();
    let writes = Promise.resolve();
    const root = join(runDirectory, 'vk-dom-fixtures');
    const baselineRoot = join(runDirectory, 'vk-dom-structure-baselines');
    const baselines = new Map();

    async function persist({ sourceId, snapshot, label = 'window', metadata = null }) {
        if (!snapshot || typeof snapshot.html !== 'string' || !/^<html(?:\s|>)/iu.test(snapshot.html)) {
            throw new Error('VK DOM fixture: invalid documentElement.outerHTML');
        }
        if (!sourceId) throw new Error('VK DOM fixture: sourceId is required');
        const key = String(sourceId);
        const token = sha256(Buffer.from(key)).slice(0, 16);
        const slug = key.replace(/[^a-z0-9_-]+/giu, '-').slice(0, 50) || 'vk';
        const sourceDir = join(root, `${slug}-${token}`);
        const entry = sources.get(key) || {
            manifest: { schemaVersion: 1, runId, captureId: `${runId}-${token}`,
                sourceId: key, status: 'snapshots-persisted', createdAt: iso(), iterations: [] },
            nextIteration: 0, sourceDir,
        };
        if (!sources.has(key)) sources.set(key, entry);
        const number = ++entry.nextIteration;
        // Serialize disk commits for a source: even concurrent callbacks cannot
        // overwrite an older manifest or claim an uncommitted snapshot exists.
        const work = async () => {
            const dir = join(sourceDir, 'iterations', String(number).padStart(6, '0'));
            await fs.mkdir(dir, { recursive: true });
            const html = Buffer.from(snapshot.html, 'utf8');
            const hash = sha256(html);
            const meta = { schemaVersion: 1, captureId: entry.manifest.captureId,
                iteration: number, sourceId: key, label: String(label),
                capturedAt: snapshot.capturedAt || iso(),
                sourceUrl: metadata?.sourceUrl || null,
                htmlBytes: html.length, htmlSha256: hash,
                ...snapshot.state,
                // This provenance describes a capture, NOT a parser output.
                parserResultIncluded: false,
            };
            const resourceData = { captureId: entry.manifest.captureId, iteration: number,
                htmlSha256: hash, resources: snapshot.resources || [] };
            // html remains unmodified and is never re-serialized from a DOMParser.
            await atomicWrite(join(dir, 'dom.html'), html);
            await atomicWrite(join(dir, 'dom-meta.json'), json(meta));
            await atomicWrite(join(dir, 'dom-state.json'), json(snapshot.state));
            await atomicWrite(join(dir, 'resources.json'), json(resourceData));
            const record = { iteration: number, label: String(label), capturedAt: meta.capturedAt,
                htmlBytes: html.length, htmlSha256: hash,
                pageUrl: meta.pageUrl, scrollY: meta.scrollY,
                relativeDirectory: relative(sourceDir, dir).replaceAll('\\', '/'),
                metadata: metadata || null };
            entry.manifest.iterations.push(record);
            await atomicWrite(join(sourceDir, 'manifest.json'), json(entry.manifest));
            if (typeof onPersist === 'function') onPersist({ ...record, sourceId: key, sourceDir });
            return { html: snapshot.html, captureId: entry.manifest.captureId,
                iteration: number, htmlSha256: hash,
                domPath: join(dir, 'dom.html'), manifestPath: join(sourceDir, 'manifest.json') };
        };
        const result = writes.then(work);
        writes = result.catch(() => {});
        return result;
    }

    async function capture({ page, sourceId, label, metadata = null }) {
        const snapshot = await readVkBrowserDom(page);
        return persist({ sourceId, snapshot, label, metadata });
    }

    /** One original, no-scroll baseline per VK source for studying card structure. */
    async function captureStructureBaseline({ page, sourceId, label = 'initial-before-scroll' } = {}) {
        if (!sourceId) throw new Error('VK DOM baseline: sourceId is required');
        const key = String(sourceId);
        if (baselines.has(key)) return baselines.get(key);
        // A failed attempt is not memoized: later calls can retry with the same page.
        const pending = (async () => {
            const quiet = await waitForVkStructureQuiet(page);
            const snapshot = await readVkBrowserDom(page, { includeStructure: true });
            const token = sha256(Buffer.from(key)).slice(0, 16);
            const slug = key.replace(/[^a-z0-9_-]+/giu, '-').slice(0, 50) || 'vk';
            const dir = join(baselineRoot, `${slug}-${token}`);
            await fs.mkdir(dir, { recursive: true });
            const html = Buffer.from(snapshot.html, 'utf8');
            const htmlSha256 = sha256(html);
            const meta = { schemaVersion: 1, kind: 'one-page-before-scroll',
                sourceId: key, runId, label, capturedAt: snapshot.capturedAt,
                scrollCapturedByBaseline: false, // Does not imply current scrollY === 0.
                quiet, htmlBytes: html.length, htmlSha256,
                ...snapshot.state, parserResultIncluded: false,
                templateVerified: false, postCardsVerified: false };
            const structure = { ...snapshot.structure,
                rawDomSha256: htmlSha256, sourceId: key, capturedAt: snapshot.capturedAt };
            // All artifacts derive from the one browser DOM observation. No parser
            // output is used as ground truth; no fabricated examples/template.
            await atomicWrite(join(dir, 'dom.raw.html'), html);
            await atomicWrite(join(dir, 'page-state.json'), json(meta));
            await atomicWrite(join(dir, 'dom.structure.json'), json(structure));
            // Persist the observed selector evidence separately so production
            // exact parsing can consume the same baseline contract without
            // treating structure.json as parser output.
            await atomicWrite(join(dir, 'selector-contract.json'), json({
                schemaVersion: 1, sourceId: key, rawDomSha256: htmlSha256,
                selectorContract: structure.selectorContract || {},
                evidence: 'derived-only-from-this-baseline-dom',
            }));
            await atomicWrite(join(dir, 'resources.json'), json({ htmlSha256,
                resources: snapshot.resources || [] }));
            await atomicWrite(join(dir, 'manifest.json'), json({ schemaVersion: 1,
                sourceId: key, runId, kind: 'one-page-before-scroll',
                capturedAt: snapshot.capturedAt, htmlSha256,
                htmlBytes: html.length, quiet,
                files: ['dom.raw.html', 'page-state.json', 'dom.structure.json', 'selector-contract.json', 'resources.json'],
                verifiedExpectedAnnouncements: false, verifiedCardTemplate: false,
                requiresManualReview: true }));
            await atomicWrite(join(dir, 'PROMPT_FOR_DOM_AUDIT_RU.txt'),
                'Это эталонный один DOM реальной VK-вкладки ДО прокруток текущего парсера.\n' +
                'Проверь manifest.json и SHA-256 raw HTML. Анализируй dom.raw.html как первичный вход,\n' +
                'а dom.structure.json, selector-contract.json, page-state.json и resources.json только как контекст.\n' +
                'Найди повторяющиеся контейнеры публикаций, проверь 3–5 реальных экземпляров,\n' +
                'восстанови точные пути к postId, ссылке, полному тексту, датам и каждому media URL.\n' +
                'Покажи для каждого поля индекс DOM-узла/путь/атрибут и настоящий пример из raw HTML.\n' +
                'Не объявляй найденный по ссылке кандидат проверенной карточкой; не выдумывай\n' +
                'ожидаемые анонсы, которых нет в слепке. Если тип карточки отсутствует, сообщи это.\n' +
                'Никакой VK, браузер, сеть или AI не нужны для исполнения будущего офлайн-парсера.\n' +
                'Слепок одной страницы НЕ доказывает полноту всей ленты; полные итерации — в ../vk-dom-fixtures/.\n');
            const record = { sourceId: key, baselineDir: dir, htmlBytes: html.length,
                htmlSha256, nodeCount: structure.nodeCount,
                wallLinkCandidates: structure.postLinkCandidates.length,
                selectorContract: structure.selectorContract || {},
                quiet, scrollY: snapshot.state.scrollY };
            if (typeof onPersist === 'function') onPersist({ ...record, kind: 'structure-baseline' });
            return record;
        })();
        baselines.set(key, pending);
        try { return await pending; }
        catch (error) { if (baselines.get(key) === pending) baselines.delete(key); throw error; }
    }
    return { capture, persist, captureStructureBaseline, root, baselineRoot };
}
