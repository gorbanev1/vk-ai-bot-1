/** Offline verification of immutable VK fixture bytes; no VK/browser/AI/network. */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function verifyVkDomFixture(sourceDirectory) {
    const base = resolve(sourceDirectory);
    const manifest = JSON.parse(await readFile(join(base, 'manifest.json'), 'utf8'));
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.iterations) || !manifest.iterations.length) {
        throw new Error('VK fixture: empty or unsupported manifest');
    }
    const records = [];
    for (const entry of manifest.iterations) {
        const dir = resolve(base, String(entry.relativeDirectory || ''));
        if (!dir.startsWith(`${base}${sep}`)) throw new Error('VK fixture: invalid iteration directory');
        const html = await readFile(join(dir, 'dom.html'));
        const meta = JSON.parse(await readFile(join(dir, 'dom-meta.json'), 'utf8'));
        const state = JSON.parse(await readFile(join(dir, 'dom-state.json'), 'utf8'));
        const resources = JSON.parse(await readFile(join(dir, 'resources.json'), 'utf8'));
        const hash = createHash('sha256').update(html).digest('hex');
        if (hash !== entry.htmlSha256 || hash !== meta.htmlSha256 || hash !== resources.htmlSha256) {
            throw new Error(`VK fixture: HTML hash mismatch in iteration ${entry.iteration}`);
        }
        if (html.length !== meta.htmlBytes || html.length !== entry.htmlBytes) {
            throw new Error(`VK fixture: HTML byte count mismatch in iteration ${entry.iteration}`);
        }
        if (state.pageUrl !== meta.pageUrl || !Array.isArray(resources.resources)) {
            throw new Error(`VK fixture: invalid state or resources in iteration ${entry.iteration}`);
        }
        records.push({ iteration: entry.iteration, bytes: html.length, sha256: hash,
            resources: resources.resources.length });
    }
    return { captureId: manifest.captureId, sourceId: manifest.sourceId,
        iterations: records.length, records };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
    const directory = process.argv[2];
    if (!directory) {
        console.error('Usage: node scripts/vk-dom-fixture-verify.mjs <vk-dom-fixtures/source-id-hash>');
        process.exitCode = 2;
    } else {
        try { console.log(JSON.stringify(await verifyVkDomFixture(directory), null, 2)); }
        catch (error) { console.error(error?.message || error); process.exitCode = 1; }
    }
}
