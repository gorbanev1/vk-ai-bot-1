import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

const MAX_QUERY_COUNT = 50;
const MAX_QUERY_ROWS = 500;
const MAX_QUERY_BYTES = 12_000;
const MAX_RESULT_BYTES = 48 * 1024;
const database = new DatabaseSync(workerData.databasePath, { readOnly: true });
database.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;');
let queryCount = 0;

function safeValue(value, depth = 0) {
    if (depth > 5) return '[depth-limit]';
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.slice(0, 12_000);
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'bigint') return String(value);
    if (Array.isArray(value)) return value.slice(0, MAX_QUERY_ROWS).map((item) => safeValue(item, depth + 1));
    if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, safeValue(item, depth + 1)]));
    return String(value).slice(0, 12_000);
}
function readQuery(sqlValue, paramsValue) {
    if (++queryCount > MAX_QUERY_COUNT) throw new Error('Не более 50 запросов к базе за запуск модуля.');
    const sql = String(sqlValue || '').trim().replace(/;\s*$/u, '');
    if (Buffer.byteLength(sql, 'utf8') > MAX_QUERY_BYTES) throw new Error('SQL-запрос слишком длинный.');
    if (!/^(?:SELECT|WITH)\b/iu.test(sql) || /;|\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE|VACUUM|ATTACH|DETACH|PRAGMA|REINDEX|ANALYZE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/iu.test(sql) || /\b(?:sqlite_master|sqlite_schema|sqlite_temp_master|sqlite_temp_schema)\b/iu.test(sql)) {
        throw new Error('Разрешены только одиночные запросы чтения.');
    }
    const params = Array.isArray(paramsValue) ? paramsValue.slice(0, 50).map((item) => item === null || ['string', 'number', 'bigint', 'boolean'].includes(typeof item) ? item : String(item)) : [];
    const rows = database.prepare('SELECT * FROM (' + sql + ') AS patrol_read LIMIT ' + MAX_QUERY_ROWS).all(...params).map((row) => safeValue(row));
    if (Buffer.byteLength(JSON.stringify(rows), 'utf8') > MAX_RESULT_BYTES) throw new Error('Результат запроса превышает лимит размера.');
    return rows;
}

parentPort.on('message', ({ id, sql, params }) => {
    try { parentPort.postMessage({ id, ok: true, result: readQuery(sql, params) }); }
    catch (error) { parentPort.postMessage({ id, ok: false, error: String(error?.message || error).slice(0, 1000) }); }
});
parentPort.on('close', () => { try { database.close(); } catch {} });
