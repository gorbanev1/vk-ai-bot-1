export function isPrashnaAllowedForPlatform(platform = 'vk') {
    return ['vk','telegram'].includes(String(platform ?? 'vk').toLowerCase());
}

export function getAstrologyHelpLines({platform='vk',isPrivate=false}={}) {
    const telegram=String(platform).toLowerCase()==='telegram';
    const lines=['',telegram?'НАТАЛ · ЛОКАЛЬНЫЙ РАСЧЁТ':'НАТАЛ И ПРАШНА · ЛОКАЛЬНЫЙ РАСЧЁТ',
        '• Swiss Ephemeris рассчитывает положения планет и дома локально на сервере; GPT-6 Luna — базовая модель для интерпретации.',
        '• Натал: дата, время и место рождения. «локалэфемериды» — расширенный пакет расчёта; «нелокал» не отключает обязательный расчёт.',
        '• Отдельно рассчитываются 16 классических варг, семь Бхинна-аштакаварг и Сарваштакаварга (337 бинду), карты от Луны и Солнца и гармоники D1–D60. Полная Шадбала ещё не реализована.',
    ];
    if(!telegram)lines.push('• Прашна: «прашна Воронеж — <вопрос>»; можно добавить «подробно».');
    if(isPrivate)lines.push('• Чем точнее время и место рождения, тем точнее исходные данные карты.');
    return lines;
}
export function resolveHelpContextProfile({
    platform = 'vk',
    isPrivate = false,
    isOwner = false,
    vkImageLimit = 5,
    telegramImageLimit = 2,
}) {
    const telegram = String(platform).toLowerCase() === 'telegram';

    if (isOwner && isPrivate) {
        return {
            id: 'owner',
            title: `📖 СПРАВКА ВЛАДЕЛЬЦА · ${telegram ? 'TELEGRAM ЛС' : 'VK ЛС'}`,
            telegram,
            private: true,
            owner: true,
            imageLimit: null,
            prashnaEnabled: true,
            imageLimitText: 'GPT image-2: для владельца дневной лимит отключён.',
        };
    }

    if (isPrivate && telegram) {
        return {
            id: 'telegram-dm',
            title: '📖 СПРАВКА · TELEGRAM ЛС',
            telegram: true,
            private: true,
            owner: false,
            imageLimit: telegramImageLimit,
            prashnaEnabled: true,
            imageLimitText: `GPT image-2: ${telegramImageLimit} изображения в сутки на пользователя Telegram; общий счётчик для ЛС и Telegram-групп.`,
        };
    }

    if (isPrivate) {
        return {
            id: 'vk-dm',
            title: '📖 СПРАВКА · VK ЛС',
            telegram: false,
            private: true,
            owner: false,
            imageLimit: vkImageLimit,
            prashnaEnabled: true,
            imageLimitText: `GPT image-2: ${vkImageLimit} изображений в сутки на пользователя VK.`,
        };
    }

    if (isOwner && !isPrivate) {
        return {
            id: telegram ? 'telegram-owner-chat' : 'vk-owner-chat',
            title: telegram ? '📖 СПРАВКА ВЛАДЕЛЬЦА · TELEGRAM-ГРУППА' : '📖 СПРАВКА ВЛАДЕЛЬЦА · VK-КОНФА',
            telegram,
            private: false,
            owner: true,
            imageLimit: null,
            prashnaEnabled: true,
            imageLimitText: 'GPT image-2: владельцу лимит не применяется.',
        };
    }

    if (telegram) {
        return {
            id: 'telegram-chat',
            title: '📖 СПРАВКА · TELEGRAM-ГРУППА',
            telegram: true,
            private: false,
            owner: false,
            imageLimit: telegramImageLimit,
            prashnaEnabled: true,
            imageLimitText: `GPT image-2: ${telegramImageLimit} изображения в сутки на пользователя Telegram; тот же счётчик используется в Telegram ЛС.`,
        };
    }

    return {
        id: 'vk-chat',
        title: '📖 СПРАВКА · VK-КОНФА',
        telegram: false,
        private: false,
        owner: false,
        imageLimit: vkImageLimit,
        prashnaEnabled: true,
        imageLimitText: `GPT image-2: ${vkImageLimit} изображений в сутки на пользователя VK.`,
    };
}
