import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';

function safeFileStem(value, fallback = 'page') {
    const stem = String(value ?? '')
        .normalize('NFKC')
        .replace(/[^a-z0-9._-]+/giu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 100);
    return stem || fallback;
}

/** A replace-on-each-run directory retaining a complete QTickets DOM audit. */
export function createQticketsDomSnapshot({ dataDirectory = './data', runId = new Date().toISOString().replace(/[:.]/gu, '-') } = {}) {
    const dataRoot = resolve(dataDirectory);
    const root = resolve(dataRoot, 'qtickets-dom-snapshot');
    if (root === dataRoot || !root.startsWith(`${dataRoot}${sep}`)) {
        throw new Error('Invalid QTickets DOM snapshot directory');
    }
    if (existsSync(root)) {
        const entries = readdirSync(root, { withFileTypes: true });
        for (const entry of entries) {
            const target = resolve(root, entry.name);
            if (basename(target) !== entry.name || resolve(target, '..') !== root) continue;
            rmSync(target, { recursive: true, force: false, maxRetries: 3, retryDelay: 200 });
        }
    }
    mkdirSync(root, { recursive: true });
    const manifestPath = join(root, 'manifest.json');
    const manifest = {
        runId: String(runId),
        startedAt: new Date().toISOString(),
        completedAt: null,
        status: 'running',
        pages: [],
    };
    const persist = () => writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    persist();

    return {
        directory: root,
        savePage({ kind, url, html, metadata = {} }) {
            const index = manifest.pages.length + 1;
            const fileName = `${String(index).padStart(4, '0')}-${safeFileStem(kind)}-${safeFileStem(metadata.id || metadata.title || url)}.html`;
            const body = String(html ?? '');
            writeFileSync(join(root, fileName), body, 'utf8');
            manifest.pages.push({
                index, kind: String(kind || 'page'), file: fileName, url: String(url || ''),
                capturedAt: new Date().toISOString(), htmlBytes: Buffer.byteLength(body, 'utf8'),
                ...metadata,
            });
            persist();
            return fileName;
        },
        record({ kind, url, metadata = {} }) {
            manifest.pages.push({
                index: manifest.pages.length + 1,
                kind: String(kind || 'page'),
                url: String(url || ''),
                capturedAt: new Date().toISOString(),
                ...metadata,
            });
            persist();
        },
        update(metadata = {}) {
            Object.assign(manifest, metadata);
            persist();
        },
        finish(status = 'completed', metadata = {}) {
            Object.assign(manifest, metadata, { status, completedAt: new Date().toISOString() });
            persist();
            return { directory: root, manifestPath, pageCount: manifest.pages.length, status };
        },
    };
}
