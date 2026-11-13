import { getQuickJS } from 'quickjs-emscripten';
import { parentPort, workerData } from 'node:worker_threads';

const CHANNEL_BYTES = 512 * 1024;
const channel = new SharedArrayBuffer(8 + CHANNEL_BYTES);
const state = new Int32Array(channel, 0, 2);
const payload = new Uint8Array(channel, 8);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let sequence = 0;

parentPort.on('message', (message) => {
    if (message?.type !== 'response' || message.id !== Atomics.load(state, 0)) return;
    const bytes = encoder.encode(JSON.stringify(message));
    if (bytes.byteLength > CHANNEL_BYTES) {
        Atomics.store(state, 1, -1);
        Atomics.notify(state, 0);
        return;
    }
    payload.fill(0);
    payload.set(bytes);
    Atomics.store(state, 1, bytes.byteLength);
    Atomics.store(state, 0, -message.id);
    Atomics.notify(state, 0);
});

function rpc(action, fields = {}) {
    const id = ++sequence;
    const bytes = encoder.encode(JSON.stringify({ id, action, ...fields }));
    if (bytes.byteLength > CHANNEL_BYTES) throw new Error('API request exceeds channel limit.');
    payload.fill(0);
    payload.set(bytes);
    Atomics.store(state, 1, bytes.byteLength);
    Atomics.store(state, 0, id);
    parentPort.postMessage({ type: 'call', id, channel });
    Atomics.wait(state, 0, id);
    const length = Atomics.load(state, 1);
    if (length < 0 || length > CHANNEL_BYTES) throw new Error('Invalid API response length.');
    const response = JSON.parse(decoder.decode(payload.subarray(0, length)));
    if (!response.ok) throw new Error(String(response.error || 'Module operation failed.'));
    return response.result;
}

let runtime;
let context;
try {
    const quickjs = await getQuickJS();
    runtime = quickjs.newRuntime();
    runtime.setMemoryLimit(48 * 1024 * 1024);
    runtime.setMaxStackSize(512 * 1024);
    context = runtime.newContext();
    const moduleSource = String(workerData.moduleSource || '');
    runtime.setModuleLoader((name) => {
        if (name === 'patrol-module:__entry__') return moduleSource;
        if (!name.startsWith('patrol-module:') || !/^[a-z][a-z0-9_-]{0,63}$/iu.test(name.slice('patrol-module:'.length))) throw new Error('Only adaptive sibling modules may be imported.');
        return String(rpc('module.source', { name: name.slice('patrol-module:'.length) }));
    }, (_baseName, requestedName) => {
        const value = String(requestedName || '');
        if (value === 'patrol-module:__entry__') return value;
        const match = value.match(/^\.\/([a-z][a-z0-9_-]{0,63})(?:\.mjs)?$/iu);
        if (!match) throw new Error('Only relative adaptive sibling imports are allowed.');
        return 'patrol-module:' + match[1];
    });
    const inputJson = JSON.stringify(workerData.input ?? {});
    const apiSource = "globalThis.api = Object.freeze({ input: Object.freeze(JSON.parse(" + JSON.stringify(inputJson) + ")), db: Object.freeze({ query: (sql, params = []) => JSON.parse(__hostCall('db.query', JSON.stringify({ sql: String(sql), params }))) }), writeModule: (name, source) => JSON.parse(__hostCall('module.write', JSON.stringify({ name: String(name), source: String(source) }))), deleteModule: (name) => JSON.parse(__hostCall('module.delete', JSON.stringify({ name: String(name) }))), listModules: () => JSON.parse(__hostCall('module.list', '{}')), http: Object.freeze({ fetch: (url, options = {}) => JSON.parse(__hostCall('http.fetch', JSON.stringify({ url: String(url), options }))) }) });";
    const hostCall = context.newFunction('__hostCall', (actionHandle, payloadHandle) => {
        try {
            const action = context.getString(actionHandle);
            const fields = JSON.parse(context.getString(payloadHandle));
            const result = rpc(action, fields);
            return { value: context.newString(JSON.stringify(result ?? null)) };
        } catch (error) {
            return { error: context.newError(String(error?.message || error)) };
        }
    });
    context.setProp(context.global, '__hostCall', hostCall);
    hostCall.dispose();
    const setup = context.evalCode(apiSource, 'patrol-api.js');
    if (setup.error) throw new Error(JSON.stringify(context.dump(setup.error)));
    setup.value.dispose();
    const sourceHandle = context.newString(moduleSource);
    context.setProp(context.global, '__moduleSource', sourceHandle);
    sourceHandle.dispose();
    const runSource = "import * as loaded from 'patrol-module:__entry__'; const run = loaded.run || loaded.default; if (typeof run !== 'function') throw new Error('Module must export async function run(api).'); const result = await run(globalThis.api); globalThis.__moduleResult = JSON.stringify(result === undefined ? null : result);";
    const evaluated = context.evalCode(runSource, 'patrol-module-run.mjs', { type: 'module' });
    if (evaluated.error) throw new Error(JSON.stringify(context.dump(evaluated.error)));
    const promiseHandle = evaluated.value;
    let settled = false;
    while (true) {
        const jobs = runtime.executePendingJobs();
        if (jobs.error) throw new Error(JSON.stringify(context.dump(jobs.error)));
        const promiseState = context.getPromiseState(promiseHandle);
        if (promiseState.type === 'fulfilled') { promiseState.value.dispose(); settled = true; break; }
        if (promiseState.type === 'rejected') throw new Error(JSON.stringify(context.dump(promiseState.error)));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
    promiseHandle.dispose();
    const resultHandle = context.getProp(context.global, '__moduleResult');
    const resultText = context.getString(resultHandle);
    resultHandle.dispose();
    if (Buffer.byteLength(resultText, 'utf8') > 48 * 1024) throw new Error('Module result exceeds size limit.');
    parentPort.postMessage({ type: 'result', ok: true, result: JSON.parse(resultText) });
} catch (error) {
    parentPort.postMessage({ type: 'result', ok: false, error: String(error?.stack || error).slice(0, 3000) });
} finally {
    try { context?.dispose(); } catch {}
    try { runtime?.dispose(); } catch {}
}
