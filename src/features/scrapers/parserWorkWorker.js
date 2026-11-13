import { parentPort } from 'node:worker_threads';
parentPort.on('message', async workerData => {
try {
    let result;
    if (workerData.task === 'repair-poster-archive') {
        const { repairPosterBindingsFromArchive } = await import('./parserPosterArchiveRepair.js');
        result = repairPosterBindingsFromArchive(workerData.input);
    } else if (workerData.task === 'final-dom') {
        const { createVkFinalDomCapture } = await import('./vkDomFinalSnapshot.js');
        const { runDirectory, runId, ...input } = workerData.input;
        result = await createVkFinalDomCapture({ runDirectory, runId }).capture(input);
    } else if (workerData.task === 'load-replay-evidence') {
        const { loadParserReplayEvidence } = await import('./parserReplayEvidence.js');
        result = loadParserReplayEvidence(workerData.input);
    } else if (workerData.task === 'parse-public-post') {
        const { parsePublicPostLocally } = await import('../events/publicPostLocalParser.js');
        result = parsePublicPostLocally(workerData.input);
    } else if (workerData.task === 'archive-copy') {
        const { cpSync, rmSync, existsSync, renameSync } = await import('node:fs');
        const { randomUUID } = await import('node:crypto');
        const { source, target } = workerData.input;
        const staging = target + '.copy-' + randomUUID();
        const previous = staging + '.previous';
        try {
            cpSync(source, staging, { recursive: true, force: true, errorOnExist: false });
            if (existsSync(target)) renameSync(target, previous);
            try { renameSync(staging, target); }
            catch (error) {
                if (existsSync(previous)) renameSync(previous, target);
                throw error;
            }
            if (existsSync(previous)) rmSync(previous, { recursive: true, force: true });
            result = true;
        } finally { rmSync(staging, { recursive: true, force: true }); }
    } else throw new Error('Unknown parser work task');
    parentPort.postMessage({ result });
} catch (error) {
    parentPort.postMessage({ error: { message: error.message, stack: error.stack, code: error.code } });
}
});
