import { parentPort, workerData } from 'node:worker_threads';
import { loadLatestParserAllRecovery } from './parserAllRecovery.js';

try {
    parentPort.postMessage({ recovery: loadLatestParserAllRecovery(workerData) });
} catch (error) {
    parentPort.postMessage({ error: String(error?.message || error) });
}
