import { createHash } from 'node:crypto';
import { needsParserCapture, recoveryPostUrl } from './parserErrorRecoveryPolicy.js';

export const parserRecoveryItemKey = row => String(row?.sourceId || '').trim().toLowerCase() + '\0' + String(row?.itemId ?? '');
export function matchesParserRecoveryScope(row, scope) {
    return scope == null || (Array.isArray(scope.keys) && scope.keys.includes(parserRecoveryItemKey(row)));
}
export function createParserRecoveryScope(rows, { posterWarning = false } = {}) {
    const keys = [...new Set(rows.filter(row => row?.sourceId).map(parserRecoveryItemKey))].sort();
    return { version: 1, posterWarning, keys };
}
export function parserRecoveryScopeToken(scope) {
    return createHash('sha256').update(JSON.stringify([Boolean(scope.posterWarning), scope.keys])).digest('hex').slice(0, 16);
}
export function parserRecoveryActions(rows, scope) {
    const current = rows.filter(row => matchesParserRecoveryScope(row, scope));
    const local = current.some(row => row.archiveDirectory || row.rawCachePath || row.tracePath ||
        row.evidenceHistory?.length || row.item?.text || row.item?.imageUrls?.length);
    const actions = [];
    if (current.length && (scope.posterWarning || local)) actions.push(['archive', '🛠 Исправить из архива']);
    if (current.some(row => recoveryPostUrl(row) && (scope.posterWarning || needsParserCapture(row)))) {
        actions.push(['browser', '🌐 Перепарсить нескачанное']);
    }
    actions.push(['status', '🔎 Проверить состояние']);
    return actions;
}
export function buildParserRecoveryMarkup(rows, scope) {
    const token = parserRecoveryScopeToken(scope);
    return { inline_keyboard: parserRecoveryActions(rows, scope).map(([action, text]) => [
        { text, callback_data: 'parser_fix:' + action + ':' + token },
    ]) };
}
export function parseParserRecoveryCallback(data) {
    const match = String(data || '').match(/^parser_fix:(archive|browser|status):([a-f0-9]{16})$/u);
    return match ? { action: match[1], token: match[2] } : null;
}
