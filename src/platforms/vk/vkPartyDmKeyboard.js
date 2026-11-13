const BUTTON_COMMANDS = [
    ['☀️ Основные сегодня', 'тусы сегодня'],
    ['🌐 Вообще все сегодня', 'вообще все тусы сегодня'],
    ['🌅 Основные завтра', 'тусы завтра'],
    ['🌐 Вообще все завтра', 'вообще все тусы завтра'],
    ['📅 Основные эта неделя', 'тусы эта неделя'],
    ['🌐 Вообще все эта неделя', 'вообще все тусы эта неделя'],
];

export function buildVkPartyDmKeyboard() {
    const button = ([label, command]) => ({
        action: { type: 'text', label, payload: JSON.stringify({ partyCommand: command }) },
        color: 'secondary',
    });
    return JSON.stringify({ inline: false, one_time: false, buttons: [
        BUTTON_COMMANDS.slice(0, 2).map(button),
        BUTTON_COMMANDS.slice(2, 4).map(button),
        BUTTON_COMMANDS.slice(4, 6).map(button),
    ] });
}

export function resolveVkPartyDmCommand(text = '', payload = null) {
    const candidates = [payload];
    if (payload && typeof payload === 'object') {
        candidates.push(payload.message?.payload, payload.object?.payload, payload.object?.message?.payload);
    }
    for (const candidate of candidates) {
        try {
            const value = typeof candidate === 'string' ? JSON.parse(candidate) : candidate;
            if (value?.partyCommand) return String(value.partyCommand).trim();
        } catch {
            // Ignore unrelated or malformed VK payloads.
        }
    }
    const normalized = String(text || '').trim().toLocaleLowerCase('ru');
    return BUTTON_COMMANDS.find(([label]) => label.toLocaleLowerCase('ru') === normalized)?.[1] || '';
}

export function isVkPartyDmHintRequest(text, isPrivate) {
    return Boolean(isPrivate) && /^тусы$/iu.test(String(text || '').trim());
}
