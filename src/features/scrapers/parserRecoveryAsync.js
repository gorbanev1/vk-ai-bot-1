import { Worker } from 'node:worker_threads';

// Reading the checkpoint directory can take minutes on a large installation.
// Keep synchronous legacy recovery work off the Telegram event loop.
export function loadLatestParserAllRecoveryAsync(options = {}) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./parserRecoveryWorker.js', import.meta.url), { workerData: options, execArgv: [] });
        worker.once('message', message => message.error ? reject(new Error(message.error)) : resolve(message.recovery));
        worker.once('error', reject);
        worker.once('exit', code => { if (code !== 0) reject(new Error('Parser recovery worker exited: ' + code)); });
    });
}
