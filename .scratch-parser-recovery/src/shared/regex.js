/** Экранирует пользовательскую строку перед вставкой в RegExp. */
export function escapeRegExp(value) {
    return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
