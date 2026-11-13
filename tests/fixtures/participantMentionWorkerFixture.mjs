import { parentPort, workerData } from 'node:worker_threads';
parentPort.on('message', ({messages}) => {
    if (workerData.participant.mode === 'error') throw new Error('fixture failure');
    if (workerData.participant.mode === 'exit') { process.exit(0); }
    if (workerData.participant.mode === 'hang') { for (;;) {} }
    parentPort.postMessage({type: 'batch', scanned: messages.length, matches: []});
    if (workerData.participant.mode === 'partial') { for (;;) {} }
});
parentPort.postMessage({type: 'ready'});
