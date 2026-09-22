/**
 * Преобразует значение в целое число и удерживает его в допустимом диапазоне.
 * Некорректные значения из .env не должны ломать запуск — используется fallback.
 */
export function clampInteger(value, minimum, maximum, fallback) {
    const parsed = Number.parseInt(value, 10);

    if (!Number.isSafeInteger(parsed)) {
        return fallback;
    }

    return Math.min(maximum, Math.max(minimum, parsed));
}
