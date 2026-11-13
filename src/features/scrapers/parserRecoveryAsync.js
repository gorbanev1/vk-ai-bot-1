import { Worker } from 'node:worker_threads';

// Reading the checkpoint directory can take minutes on a large installation.
// Keep synchronous legacy recovery work off the Telegram event loop.
export function loadLatestParserAllRecoveryAsync(options = {}) {
    const requestedId = String(process.env.PARSER_AUTO_RESUME_CHECKPOINT_ID || '').trim();
    const workerOptions = requestedId ? { ...options, exactId: requestedId } : options;
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./parserRecoveryWorker.js', import.meta.url), { workerData: workerOptions, execArgv: [] });
        worker.once('message', message => message.error ? reject(new Error(message.error)) : resolve(message.recovery));
        worker.once('error', reject);
        worker.once('exit', code => { if (code !== 0) reject(new Error('Parser recovery worker exited: ' + code)); });
    });
}
