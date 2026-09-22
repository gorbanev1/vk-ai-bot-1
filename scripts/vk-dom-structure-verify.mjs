/** Offline verifier: run in Node, without VK, a browser, a profile, AI, or network. */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function verifyVkDomStructureBaseline(directory) {
    const root = resolve(directory);
    const [html, manifestRaw, metaRaw, structureRaw, resourcesRaw, selectorContractRaw] = await Promise.all([
        readFile(join(root, 'dom.raw.html')),
        readFile(join(root, 'manifest.json'), 'utf8'),
        readFile(join(root, 'page-state.json'), 'utf8'),
        readFile(join(root, 'dom.structure.json'), 'utf8'),
        readFile(join(root, 'resources.json'), 'utf8'),
        readFile(join(root, 'selector-contract.json'), 'utf8').catch(() => null),
    ]);
    const manifest = JSON.parse(manifestRaw);
    const meta = JSON.parse(metaRaw);
    const structure = JSON.parse(structureRaw);
    const resources = JSON.parse(resourcesRaw);
    const selectorContract = selectorContractRaw ? JSON.parse(selectorContractRaw) : null;
    const sha = createHash('sha256').update(html).digest('hex');
    if (manifest.kind !== 'one-page-before-scroll' || meta.kind !== manifest.kind) {
        throw new Error('VK baseline: unsupported capture kind');
    }
    if (manifest.htmlSha256 !== sha || meta.htmlSha256 !== sha ||
        structure.rawDomSha256 !== sha || resources.htmlSha256 !== sha) {
        throw new Error('VK baseline: raw DOM hash mismatch');
    }
    if (manifest.htmlBytes !== html.length || meta.htmlBytes !== html.length) {
        throw new Error('VK baseline: raw DOM byte length mismatch');
    }
    if (!Array.isArray(structure.elements) || structure.elements.length !== structure.nodeCount ||
        !Array.isArray(structure.postLinkCandidates) || !Array.isArray(resources.resources)) {
        throw new Error('VK baseline: structural/resource index invalid');
    }
    if (selectorContract) {
        if (selectorContract.rawDomSha256 !== sha ||
            selectorContract.sourceId !== manifest.sourceId ||
            selectorContract.evidence !== 'derived-only-from-this-baseline-dom' ||
            !selectorContract.selectorContract || typeof selectorContract.selectorContract !== 'object') {
            throw new Error('VK baseline: selector contract provenance invalid');
        }
        for (const [field, evidence] of Object.entries(selectorContract.selectorContract)) {
            if (!evidence || typeof evidence.selected !== 'string' || !Array.isArray(evidence.observations)) {
                throw new Error(`VK baseline: selector contract field invalid: ${field}`);
            }
        }
    }
    for (let i = 0; i < structure.elements.length; i += 1) {
        const node = structure.elements[i];
        if (node.index !== i || (node.parentIndex !== null &&
            (!Number.isInteger(node.parentIndex) || node.parentIndex >= i || node.parentIndex < 0))) {
            throw new Error(`VK baseline: invalid node index at ${i}`);
        }
    }
    if (manifest.verifiedExpectedAnnouncements !== false || manifest.verifiedCardTemplate !== false) {
        throw new Error('VK baseline: template/expected results cannot be self-certified');
    }
    return { sourceId: manifest.sourceId, htmlSha256: sha, htmlBytes: html.length,
        capturedAt: manifest.capturedAt, stableBeforeCapture: Boolean(manifest.quiet?.stable),
        nodeCount: structure.nodeCount, wallLinkCandidates: structure.postLinkCandidates.length,
        parserResultIncluded: false, templateVerified: false,
        selectorContract: selectorContract?.selectorContract || structure.selectorContract || null };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
    const directory = process.argv[2];
    if (!directory) {
        console.error('Usage: node scripts/vk-dom-structure-verify.mjs <vk-dom-structure-baselines/source-folder>');
        process.exitCode = 2;
    } else {
        try { console.log(JSON.stringify(await verifyVkDomStructureBaseline(directory), null, 2)); }
        catch (error) { console.error(error?.message || error); process.exitCode = 1; }
    }
}
