/**
 * Платформенная политика дневной квоты вызовов GPT image-модели.
 * Владелец обходится общим unlimited-механизмом приложения; здесь выбирается
 * только лимит обычного пользователя для соответствующей платформы.
 */
export function resolveGptImageDailyLimit({
    platform,
    vkLimit,
    telegramLimit = 2,
}) {
    const normalizedPlatform = String(platform ?? '').trim().toLowerCase();
    const safeVkLimit = Math.max(1, Number(vkLimit) || 1);
    const safeTelegramLimit = Math.max(1, Number(telegramLimit) || 2);

    return normalizedPlatform === 'telegram'
        ? safeTelegramLimit
        : safeVkLimit;
}
