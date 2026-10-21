/** Offline verifier for the single final per-source VK DOM; no browser or network. */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function verifyVkFinalDomSnapshot(directory) {
    const dir = resolve(directory);
    const [html, manifestString, metadataString, structuralString, resourcesString, progressString] = await Promise.all([
        readFile(join(dir, 'dom.raw.html')),
        readFile(join(dir, 'manifest.json'), 'utf8'),
        readFile(join(dir, 'page-state.json'), 'utf8'),
        readFile(join(dir, 'dom.structure.json'), 'utf8'),
        readFile(join(dir, 'resources.json'), 'utf8'),
        readFile(join(dir, 'pagination-progress.json'), 'utf8'),
    ]);
    const manifest = JSON.parse(manifestString);
    const metadata = JSON.parse(metadataString);
    const structural = JSON.parse(structuralString);
    const resources = JSON.parse(resourcesString);
    const progress = JSON.parse(progressString);
    const sha = createHash('sha256').update(html).digest('hex');
    if (manifest.kind !== 'one-final-dom-after-pagination' || metadata.kind !== manifest.kind ||
        manifest.status !== 'complete' || !['up', 'down'].includes(manifest.paginationDirection) ||
        manifest.paginationDirection !== metadata.paginationDirection ||
        manifest.paginationDirection !== progress.direction) {
        throw new Error('Final VK DOM: invalid kind, status or direction');
    }
    if (metadata.htmlBytes !== html.byteLength || manifest.htmlBytes !== html.byteLength ||
        metadata.htmlSha256 !== sha || manifest.htmlSha256 !== sha ||
        structural.rawDomSha256 !== sha || resources.htmlSha256 !== sha) {
        throw new Error('Final VK DOM: raw DOM hash/byte-length mismatch');
    }
    if (!Array.isArray(structural.elements) || structural.elements.length !== structural.nodeCount ||
        !Array.isArray(resources.resources) || !Array.isArray(progress.progress) ||
        metadata.parserResultIncluded !== false || !Number.isInteger(manifest.fullDomSnapshotsDuringPagination) ||
        manifest.fullDomSnapshotsDuringPagination < 0 ||
        manifest.fullDomSnapshotsDuringPagination !== (manifest.checkpoints?.length || 0) ||
        manifest.finalFullDomSnapshots !== 1 || metadata.allHistoryGuaranteed !== false) {
        throw new Error('Final VK DOM: invalid derived artifacts/manifest');
    }
    for (const checkpoint of manifest.checkpoints || []) {
        if (!/^checkpoints\/\d{3}\.dom\.raw\.html$/u.test(checkpoint.file)) {
            throw new Error('Final VK DOM: invalid checkpoint file path');
        }
        const checkpointHtml = await readFile(join(dir, checkpoint.file));
        if (checkpoint.htmlBytes !== checkpointHtml.byteLength ||
            checkpoint.htmlSha256 !== createHash('sha256').update(checkpointHtml).digest('hex')) {
            throw new Error('Final VK DOM: checkpoint hash/byte-length mismatch');
        }
    }
    return { sourceId: manifest.sourceId, direction: manifest.paginationDirection,
        htmlSha256: sha, htmlBytes: html.byteLength, preparationStatus: manifest.preparationStatus,
        nodeCount: structural.nodeCount, captureIsOfflineReproducible: true,
        allHistoryGuaranteed: false };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
    if (!process.argv[2]) {
        console.error('Usage: node scripts/vk-dom-final-verify.mjs <.../vk-dom-final-snapshots/source-folder>');
        process.exitCode = 2;
    } else {
        try { console.log(JSON.stringify(await verifyVkFinalDomSnapshot(process.argv[2]), null, 2)); }
        catch (error) { console.error(error?.message || error); process.exitCode = 1; }
    }
}
