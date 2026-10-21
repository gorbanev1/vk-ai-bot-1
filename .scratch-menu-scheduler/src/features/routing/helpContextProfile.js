export function isPrashnaAllowedForPlatform(platform = 'vk') {
    return String(platform ?? 'vk').toLowerCase() !== 'telegram';
}

export function getAstrologyHelpLines({ platform = 'vk', isPrivate = false } = {}) {
    const telegram = String(platform ?? 'vk').toLowerCase() === 'telegram';

    if (telegram) {
        return isPrivate
            ? [
                '',
                'ДЖЙОТИШ-НАТАЛ',
                '• натал <дата, точное время, место рождения и вопрос> — всегда развёрнутый ответ.',
                '• mini/gpt54/gpt55 используют максимальный локальный расчёт; pro/pro2/pro3 без локального ключа считают внутри модели.',
                '• «локалэфемериды», «локал» или «расчёт локально» включают максимальный локальный пакет; «нелокал» отключает локальный расчёт.',
                '• Для локального натала место рождения обязательно.',
            ]
            : [
                '',
                'ДЖЙОТИШ-НАТАЛ',
                '• Гигорейв натал <дата, точное время, место рождения и вопрос> — ответ всегда развёрнутый при любой модели.',
                '• mini, gpt54 и gpt55 по умолчанию получают максимальный локальный пакет; pro/pro2/pro3 без специального ключа считают карту самостоятельно.',
                '• Ключ «локалэфемериды», «локал» или «расчёт локально» включает максимальный локальный пакет; «нелокал» отключает локальный расчёт.',
            ];
    }

    return isPrivate
        ? [
            '',
            'ДЖЙОТИШ-ПРАШНА И НАТАЛ',
            '• mini/gpt54/gpt55: максимальный локальный расчёт Swiss Ephemeris/Moshier и максимальный пакет.',
            '• pro/pro2/pro3 без локального ключа считают внутри модели; с ключом «локалэфемериды», «локал» или «расчёт локально» получают максимальный локальный пакет.',
            '• прашна <город и вопрос> — краткий ответ; «подробно» или pro/pro2/pro3 включают полный технический разбор.',
            '• натал <дата, точное время, место рождения и вопрос> — всегда развёрнутый ответ.',
            '• «нелокал» принудительно отключает локальный расчёт также для лёгких моделей.',
            '• Если город прашны не найден, используется Воронеж; для локального натала место рождения обязательно.',
        ]
        : [
            '',
            'ДЖЙОТИШ-ПРАШНА И НАТАЛ',
            '• mini, gpt54 и gpt55 по умолчанию получают максимальный локальный пакет со всеми рассчитанными полями.',
            '• pro, pro2 и pro3 без специального ключа считают карту самостоятельно. Ключ «локалэфемериды», «локал» или «расчёт локально» принудительно включает тот же максимальный локальный пакет.',
            '• Гигорейв прашна <город и вопрос> — обычный краткий ответ; добавьте «подробно» или выберите pro/pro2/pro3 для полного технического разбора.',
            '• Гигорейв натал <дата, точное время, место рождения и вопрос> — ответ всегда развёрнутый при любой модели.',
            '• Ключ «нелокал» принудительно отключает локальный расчёт для любой модели.',
        ];
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
            prashnaEnabled: !telegram,
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
            prashnaEnabled: false,
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

    if (telegram) {
        return {
            id: 'telegram-chat',
            title: '📖 СПРАВКА · TELEGRAM-ГРУППА',
            telegram: true,
            private: false,
            owner: false,
            imageLimit: telegramImageLimit,
            prashnaEnabled: false,
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
