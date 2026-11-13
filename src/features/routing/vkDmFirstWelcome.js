// One-time welcome only in VK community DMs. Never use legacy event-specific FAQ.
export const VK_DM_FIRST_WELCOME = [
    '👋 Привет! Я Гигорейв — ИИ-бот сообщества. Можешь просто написать вопрос или поболтать со мной.',
    '',
    '🎉 Ищу актуальные анонсы мероприятий: «тусы» — выбор периода для основных тусовок, «ближайшие тусы» — афиша, «тусы второстепенные» — дополнительные, «вообще все тусы» — всё вместе. Можно уточнить: «тусы на выходных» или «тусы на неделю».',
    '',
    '📖 Полный список команд и возможностей: «помощь». По разделам — например, «тусы справка» или «хуинглиш помощь».',
    '',
    'ℹ️ Обычная переписка не сохраняется в локальную историю бота. Сохранение в память — только по команде «запомни».',
].join('\n');

export async function sendVkDmFirstWelcomeOnce({ isPrivate = false, isOutbox = false, userId = 0, consume, send } = {}) {
    const normalizedUserId = Number(userId);
    if (!isPrivate || isOutbox || !Number.isSafeInteger(normalizedUserId) || normalizedUserId <= 0) return false;
    if (typeof consume !== 'function' || typeof send !== 'function') throw new TypeError('Missing welcome dependencies');
    const state = consume({ userId: normalizedUserId });
    if (!state?.shouldSend) return false;
    await send(VK_DM_FIRST_WELCOME);
    return true;
}
