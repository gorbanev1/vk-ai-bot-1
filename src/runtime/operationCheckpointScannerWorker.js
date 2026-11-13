import { readdirSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

const { directory, maxFiles, startedAtMs } = workerData;
const names = readdirSync(directory);
const files = [];
for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const separator = name.indexOf('-');
    if (separator > 0 && separator <= 8) {
        const timestamp = name.slice(0, separator);
        if (/^[0-9a-z]+$/iu.test(timestamp) && Number.parseInt(timestamp, 36) >= startedAtMs) continue;
    }
    files.push(name);
}
files.sort((left, right) => left < right ? 1 : left > right ? -1 : 0);
parentPort.postMessage({ fileCount: files.length, candidates: files.slice(0, maxFiles) });
parentPort.close();
