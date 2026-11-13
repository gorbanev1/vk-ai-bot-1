import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { resolveMainDatabasePath, resolveRuntimeDataDirectory } from '../../infrastructure/database/runtimePaths.js';
import { request } from 'node:https';
import { request as httpRequest } from 'node:http';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const PATROL_MODULES_DIRECTORY = resolve(resolveRuntimeDataDirectory(), 'vk-patrol-adaptive', 'modules');
const MODULE_WORKER_PATH = fileURLToPath(new URL('./vkPatrolModuleWorker.mjs', import.meta.url));
const DATABASE_WORKER_PATH = fileURLToPath(new URL('./vkPatrolModuleDatabaseWorker.mjs', import.meta.url));
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 48 * 1024;
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_QUERY_ROWS = 500;

function ensureModulesDirectory() { mkdirSync(PATROL_MODULES_DIRECTORY, { recursive: true }); return PATROL_MODULES_DIRECTORY; }
function moduleFileName(name) {
    const value = String(name || '').trim().replace(/\.mjs$/iu, '');
    if (!/^[a-z][a-z0-9_-]{0,63}$/iu.test(value)) throw new Error('Имя модуля: латиница, цифры, _ и -; максимум 64 символа.');
    return value + '.mjs';
}
function modulePath(name) {
    const root = resolve(ensureModulesDirectory());
    const path = resolve(root, moduleFileName(name));
    if (!path.startsWith(root + sep)) throw new Error('Модуль находится вне разрешённой директории.');
    try { if (lstatSync(path).isSymbolicLink()) throw new Error('Символические ссылки в папке модулей запрещены.'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    return path;
}
export function listPatrolModules() {
    return readdirSync(ensureModulesDirectory(), { withFileTypes: true }).filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.mjs')
        .map((entry) => ({ name: entry.name.slice(0, -4), bytes: statSync(join(PATROL_MODULES_DIRECTORY, entry.name)).size }))
        .sort((a, b) => a.name.localeCompare(b.name));
}
export function writePatrolModule({ name, source }) {
    const path = modulePath(name);
    const text = String(source ?? '');
    const bytes = Buffer.byteLength(text, 'utf8');
    if (!bytes || bytes > MAX_SOURCE_BYTES) throw new Error('Размер кода должен быть от 1 до ' + MAX_SOURCE_BYTES + ' байт.');
    const temporary = path + '.' + process.pid + '.tmp';
    writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, path);
    return { name: String(name), bytes };
}
export function deletePatrolModule(name) {
    try { unlinkSync(modulePath(name)); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    return { name: String(name), deleted: true };
}
function jsonSafe(value, depth = 0) {
    if (depth > 5) return '[depth-limit]';
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.slice(0, 12_000);
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'bigint') return String(value);
    if (Array.isArray(value)) return value.slice(0, MAX_QUERY_ROWS).map((item) => jsonSafe(item, depth + 1));
    if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, jsonSafe(item, depth + 1)]));
    return String(value).slice(0, 12_000);
}
function isPublicAddress(address) {
    const value = String(address).toLowerCase();
    if (isIP(value) !== 4) return false;
    const [a, b] = value.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
        || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51))
        || (a === 203 && b === 0));
}
async function fetchPublicUrl(urlValue, options = {}, redirects = 0) {
    if (redirects > 4) throw new Error('Слишком много HTTP-перенаправлений.');
    const url = new URL(String(urlValue));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Разрешены только публичные HTTP- и HTTPS-адреса.');
    const addresses = await lookup(url.hostname, { all: true, family: 4, verbatim: true });
    if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) throw new Error('Частные сетевые адреса запрещены.');
    const pinnedAddress = addresses[0].address;
    const transport = url.protocol === 'https:' ? request : httpRequest;
    return new Promise((resolveFetch, rejectFetch) => {
        const requestHandle = transport(url, { method: options.method || 'GET', headers: options.headers || {}, timeout: 10_000, lookup: (_host, _opts, callback) => callback(null, pinnedAddress, 4) }, (response) => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
                response.resume();
                fetchPublicUrl(new URL(response.headers.location, url).toString(), options, redirects + 1).then(resolveFetch, rejectFetch);
                return;
            }
            const chunks = [];
            let size = 0;
            response.on('data', (chunk) => { size += chunk.length; if (size > 256 * 1024) { requestHandle.destroy(new Error('HTTP-ответ превышает 256 КБ.')); return; } chunks.push(chunk); });
            response.on('end', () => resolveFetch({ ok: Number(response.statusCode) >= 200 && Number(response.statusCode) < 300, status: Number(response.statusCode) || 0, url: url.toString(), headers: Object.fromEntries(Object.entries(response.headers).slice(0, 80).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value ?? '').slice(0, 4000)])), body: Buffer.concat(chunks).toString('utf8') }));
            response.on('error', rejectFetch);
        });
        requestHandle.on('timeout', () => requestHandle.destroy(new Error('Истекло время HTTP-запроса.')));
        requestHandle.on('error', rejectFetch);
        if (options.body) requestHandle.write(String(options.body).slice(0, 64 * 1024));
        requestHandle.end();
    });
}

export function runPatrolModule(name, input = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, databasePath = resolveMainDatabasePath() } = {}) {
    const selectedPath = modulePath(name);
    const moduleSource = readFileSync(selectedPath, 'utf8');
    if (Buffer.byteLength(moduleSource, 'utf8') > MAX_SOURCE_BYTES) throw new Error('Размер модуля превышает лимит.');
    const timeout = Math.max(1000, Math.min(120_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    ensureModulesDirectory();
    return new Promise((resolveResult, reject) => {
        const databaseWorker = new Worker(DATABASE_WORKER_PATH, { workerData: { databasePath: resolve(databasePath) }, resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 } });
        const databaseRequests = new Map();
        let nextDatabaseRequestId = 1;
        let databaseWorkerError = null;
        databaseWorker.on('message', (message) => {
            const request = databaseRequests.get(message?.id);
            if (!request) return;
            databaseRequests.delete(message.id);
            if (message.ok) request.resolve(message.result);
            else request.reject(new Error(String(message.error || 'Ошибка чтения базы данных.')));
        });
        databaseWorker.on('error', (error) => {
            databaseWorkerError = error;
            for (const request of databaseRequests.values()) request.reject(error);
            databaseRequests.clear();
        });
        const runDatabaseQuery = (sql, params) => new Promise((resolveQuery, rejectQuery) => {
            if (databaseWorkerError) { rejectQuery(databaseWorkerError); return; }
            const id = nextDatabaseRequestId++;
            databaseRequests.set(id, { resolve: resolveQuery, reject: rejectQuery });
            databaseWorker.postMessage({ id, sql, params });
        });
        const worker = new Worker(MODULE_WORKER_PATH, { workerData: { moduleName: String(name), moduleSource, input: jsonSafe(input) }, resourceLimits: { maxOldGenerationSizeMb: 96, stackSizeMb: 4 } });
        let settled = false;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            for (const request of databaseRequests.values()) request.reject(new Error('Выполнение модуля завершено.'));
            databaseRequests.clear();
            void databaseWorker.terminate();
            void worker.terminate();
            callback(value);
        };
        const timer = setTimeout(() => finish(reject, new Error('Адаптивный модуль превысил ограничение времени ' + timeout + ' мс.')), timeout);
        worker.on('error', (error) => finish(reject, error));
        worker.on('exit', (code) => { if (!settled && code !== 0) finish(reject, new Error('Адаптивный модуль завершился с кодом ' + code + '.')); });
        worker.on('message', (message) => {
            if (message?.type === 'result') {
                if (!message.ok) { finish(reject, new Error(String(message.error || 'Ошибка адаптивного модуля.'))); return; }
                try {
                    if (Buffer.byteLength(JSON.stringify(message.result), 'utf8') > MAX_RESULT_BYTES) throw new Error('Ответ модуля превышает ограничение размера.');
                    finish(resolveResult, jsonSafe(message.result));
                } catch (error) { finish(reject, error); }
                return;
            }
            if (message?.type !== 'call' || !Number.isSafeInteger(message.id) || !(message.channel instanceof SharedArrayBuffer)) return;
            const channelState = new Int32Array(message.channel, 0, 2);
            const channelPayload = new Uint8Array(message.channel, 8);
            const channelRequest = JSON.parse(new TextDecoder().decode(channelPayload.subarray(0, Atomics.load(channelState, 1))));
            const respond = (response) => {
                const responseBytes = new TextEncoder().encode(JSON.stringify(response));
                if (responseBytes.byteLength > channelPayload.byteLength) {
                    Atomics.store(channelState, 1, -1);
                    Atomics.store(channelState, 0, -message.id);
                    Atomics.notify(channelState, 0);
                    return;
                }
                channelPayload.fill(0);
                channelPayload.set(responseBytes);
                Atomics.store(channelState, 1, responseBytes.byteLength);
                Atomics.store(channelState, 0, -message.id);
                Atomics.notify(channelState, 0);
            };
            try {
                let result;
                if (channelRequest.action === 'module.write') result = writePatrolModule(channelRequest.payload || channelRequest);
                else if (channelRequest.action === 'module.delete') result = deletePatrolModule(channelRequest.name);
                else if (channelRequest.action === 'module.list') result = listPatrolModules();
                else if (channelRequest.action === 'module.source') {
                    result = readFileSync(modulePath(channelRequest.name), 'utf8');
                    if (Buffer.byteLength(result, 'utf8') > MAX_SOURCE_BYTES) throw new Error('Код соседнего модуля превышает лимит.');
                } else if (!['db.query', 'http.fetch'].includes(channelRequest.action)) throw new Error('Неизвестная операция модуля.');
                if (channelRequest.action === 'db.query') {
                    runDatabaseQuery(channelRequest.sql, channelRequest.params).then(
                        (queryResult) => respond({ id: message.id, ok: true, result: queryResult }),
                        (error) => respond({ id: message.id, ok: false, error: String(error?.message || error).slice(0, 1000) }),
                    );
                } else if (channelRequest.action === 'http.fetch') {
                    fetchPublicUrl(channelRequest.url, channelRequest.options).then(
                        (fetchResult) => respond({ id: message.id, ok: true, result: fetchResult }),
                        (error) => respond({ id: message.id, ok: false, error: String(error?.message || error).slice(0, 1000) }),
                    );
                } else respond({ id: message.id, ok: true, result });
            } catch (error) { respond({ id: message.id, ok: false, error: String(error?.message || error).slice(0, 1000) }); }
        });
    });
}
