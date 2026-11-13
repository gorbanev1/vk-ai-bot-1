import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';

// Archive/browser tasks stay serialized. Pure local post parsing uses a bounded
// CPU pool so several independent posts can occupy several cores at once.
const queue = [];
let worker = null, current = null;
const localQueue = [];
const localWorkers = [];
const localWorkerLimit = resolveLocalWorkerLimit();

function resolveLocalWorkerLimit(env = process.env) {
    const configured = Number.parseInt(env.PARSER_LOCAL_WORKERS, 10);
    if (Number.isInteger(configured) && configured > 0) return Math.min(12, configured);
    return Math.max(1, Math.min(6, availableParallelism()));
}

export function getParserLocalWorkerLimit() {
    return localWorkerLimit;
}

export function runParserWorkTask(task, input) {
    return new Promise((resolve, reject) => {
        queue.push({ task, input, resolve, reject });
        drain();
    });
}

// Local extraction needs data only; browser callbacks must stay on their owning thread.
export const parsePublicPostLocallyAsync = post => runLocalParserTask(
    JSON.parse(JSON.stringify(post, (_key, value) => typeof value === 'function' ? undefined : value)),
);

function runLocalParserTask(input) {
    return new Promise((resolve, reject) => {
        localQueue.push({ input, resolve, reject });
        drainLocal();
    });
}

function createLocalWorker() {
    const instance = new Worker(new URL('./parserWorkWorker.js', import.meta.url), { execArgv: [] });
    const state = { worker: instance, current: null, failed: false };
    const fail = error => {
        if (state.failed) return;
        state.failed = true;
        state.current?.reject(error);
        state.current = null;
        const index = localWorkers.indexOf(state);
        if (index >= 0) localWorkers.splice(index, 1);
        void instance.terminate();
        queueMicrotask(drainLocal);
    };
    instance.on('error', fail);
    instance.on('exit', code => {
        if (!state.failed) {
            fail(new Error('Local parser worker exited: ' + code));
        }
    });
    instance.on('message', answer => {
        if (state.failed || !state.current) return;
        const job = state.current;
        state.current = null;
        if (answer?.error) job.reject(Object.assign(new Error(answer.error.message), answer.error));
        else job.resolve(answer?.result);
        if (!localQueue.length && !localWorkers.some(item => item.current)) instance.unref();
        drainLocal();
    });
    return state;
}

function drainLocal() {
    while (localWorkers.length < Math.min(localWorkerLimit, localQueue.length)) {
        try {
            localWorkers.push(createLocalWorker());
        } catch (error) {
            const job = localQueue.shift();
            job?.reject(error);
            continue;
        }
    }
    for (const state of localWorkers) {
        if (state.failed || state.current || !localQueue.length) continue;
        state.current = localQueue.shift();
        state.worker.ref();
        try {
            state.worker.postMessage({ task: 'parse-public-post', input: state.current.input });
        } catch (error) {
            const job = state.current;
            state.current = null;
            job.reject(error);
            state.worker.unref();
        }
    }
}

function drain() {
    if (current || !queue.length) return;
    if (!worker) {
        let instance;
        try { instance = new Worker(new URL('./parserWorkWorker.js', import.meta.url), { execArgv: [] }); }
        catch (error) { queue.shift().reject(error); queueMicrotask(drain); return; }
        worker = instance;
        const failed = error => {
            if (worker !== instance) return;
            worker = null;
            const job = current; current = null;
            job?.reject(error);
            void instance.terminate();
            drain();
        };
        instance.on('error', failed);
        instance.on('exit', code => failed(new Error('Parser worker exited: ' + code)));
        instance.on('message', answer => {
            if (worker !== instance || !current) return;
            const job = current; current = null;
            if (answer.error) job.reject(Object.assign(new Error(answer.error.message), answer.error));
            else job.resolve(answer.result);
            if (queue.length) drain();
            else instance.unref();
        });
    }
    current = queue.shift();
    worker.ref();
    try { worker.postMessage({ task: current.task, input: current.input }); }
    catch (error) {
        const job = current; current = null; job.reject(error);
        worker.unref(); queueMicrotask(drain);
    }
}
