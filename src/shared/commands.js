/**
 * Общие короткие команды и распознавание упоминаний VK/Telegram без платформенной отправки сообщений.
 */
import { escapeRegExp } from './regex.js';

/** Нормальная форма короткой команды: без слеша, пунктуации и лишних пробелов. */
export function normalizeLocalCommand(value) {
    return String(value ?? '')
        .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '')
        .toLowerCase()
        .replace(/ё/gu, 'е')
        .trim()
        .replace(/^[/\\]+/u, '')
        .replace(/[?!.,:;]+$/gu, '')
        .replace(/\s+/gu, ' ')
        .trim();
}

/**
 * Делит входящее сообщение на предложения только для command routing.
 * Точка внутри URL/даты не считается границей, пока после неё нет пробела.
 * Перенос строки — жёсткая граница: обращение к боту в одной строке не
 * активирует команду из соседней строки/предложения.
 */
export function splitCommandSentences(value) {
    return String(value ?? '')
        .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '')
        .split(/(?:[\r\n]+|(?<=[.!?…])\s+)/u)
        .map((item) => item.trim())
        .filter(Boolean);
}

const COMMAND_EDGE_FILLER = '(?:эй|слушай|слушайте|пожалуйста|плиз|плз|ну|ну-ка|короче|алло|бот)';

function stripCommandEdgeFillers(value) {
    let text = String(value ?? '').trim();
    let previous = '';

    while (text && text !== previous) {
        previous = text;
        text = text
            .replace(new RegExp(`^(?:${COMMAND_EDGE_FILLER})(?:[\\s,:;—–-]+)`, 'iu'), '')
            .replace(new RegExp(`(?:[\\s,:;—–-]+)(?:${COMMAND_EDGE_FILLER})[.!?…]*$`, 'iu'), '')
            .trim();
    }

    return text;
}

/**
 * Строит консервативные варианты одной адресованной фразы.
 * Полная фраза проверяется первой; затем — вариант без вежливой обвязки и
 * пунктуационные клаузы. Все слова подряд намеренно не перебираются, чтобы
 * «Гигорейв, расскажи, что означает слово помощь» не превращалось в команду
 * «помощь» только из-за наличия этого слова внутри обычного вопроса.
 */
export function buildCommandSentenceCandidates(value) {
    const source = String(value ?? '')
        .replace(/^[\s,.!?;:—–-]+|[\s,.!?;:—–-]+$/gu, '')
        .replace(/\s{2,}/gu, ' ')
        .trim();
    if (!source) return [];

    const result = [];
    const seen = new Set();
    const add = (candidate) => {
        const clean = String(candidate ?? '')
            .replace(/^[\s,.!?;:—–-]+|[\s,.!?;:—–-]+$/gu, '')
            .replace(/\s{2,}/gu, ' ')
            .trim();
        if (!clean || seen.has(clean)) return;
        seen.add(clean);
        result.push(clean);
    };

    add(source);
    add(stripCommandEdgeFillers(source));

    const clauses = source
        .split(/\s*(?:[,;]|—|–)\s*/u)
        .map((item) => item.trim())
        .filter(Boolean);

    // Сначала длинные окна: payload команды нельзя случайно обрезать.
    for (let width = clauses.length - 1; width >= 1; width -= 1) {
        for (let start = 0; start + width <= clauses.length; start += 1) {
            const joined = clauses.slice(start, start + width).join(' ');
            add(joined);
            add(stripCommandEdgeFillers(joined));
        }
    }

    return result;
}

const VERSION_COMMANDS = new Set([
    'версия', 'версия бота', 'сборка', 'сборка бота', 'bot version',
]);
const HELP_COMMANDS = new Set([
    'помощь', 'помоги', 'команды', 'список команд', 'покажи команды',
    'покажи список команд', 'какие команды', 'все команды', 'справка',
    'help', 'commands', 'что ты умеешь', 'что ты можешь',
]);
const SOURCE_STATUS_COMMANDS = new Set([
    'парсер статус', 'парсеры статус', 'источники статус', 'тг парсер статус',
    'вк парсер статус', 'telegram parser status', 'vk parser status',
]);
const VK_CHAT_STOP_COMMANDS = new Set([
    'парсер бесед остановить', 'парсер бесед стоп', 'парсер чатов остановить',
    'парсер чатов стоп', 'беседы закрыть', 'чаты закрыть', 'vk chat parser stop',
]);

export function isVersionCommand(value) {
    return VERSION_COMMANDS.has(normalizeLocalCommand(value));
}

export function isHelpCommand(value) {
    return HELP_COMMANDS.has(normalizeLocalCommand(value));
}

export function isPublicSourcesStatusCommand(value) {
    return SOURCE_STATUS_COMMANDS.has(normalizeLocalCommand(value));
}

export function isVkChatManualStopCommand(value) {
    return VK_CHAT_STOP_COMMANDS.has(normalizeLocalCommand(value));
}

/**
 * Упоминание Telegram-бота меняется после getMe, поэтому username передаётся
 * через getter, а не фиксируется во время импорта модуля.
 */
export function createBotMentionTools({ groupId, groupIds = [], getTelegramBotUsername }) {
    const normalizedGroupIds = [...new Set(
        [groupId, ...(Array.isArray(groupIds) ? groupIds : [])]
            .map((value) => String(value ?? '').trim())
            .filter(Boolean),
    )];
    const vkMentionSources = normalizedGroupIds.map(
        (id) => `\\[club${escapeRegExp(id)}\\|[^\\]]+\\]`,
    );
    const vkMentionSource = vkMentionSources.length > 1
        ? `(?:${vkMentionSources.join('|')})`
        : vkMentionSources[0] || '(?!)';

    const getTelegramExpression = (flags) => {
        const username = String(getTelegramBotUsername?.() ?? '').trim();
        return username
            ? new RegExp(
                `(?<![\\p{L}\\p{N}_])@${escapeRegExp(username)}(?![\\p{L}\\p{N}_])`,
                flags,
            )
            : null;
    };

    const spokenBotNameSource = '(?:гигорейв|гигарейв|гигорейф|гигарейф|гигорэйв)';
    const containsBotMention = (text) => {
        const source = String(text ?? '');
        const telegramExpression = getTelegramExpression('iu');

        return (
            new RegExp(vkMentionSource, 'iu').test(source) ||
            Boolean(telegramExpression?.test(source)) ||
            new RegExp(
                `(?<![\\p{L}\\p{N}_])${spokenBotNameSource}(?![\\p{L}\\p{N}_])`,
                'iu',
            ).test(source)
        );
    };
    const replaceBotMentions = (text, replacement = ' ') => {
        let source = String(text ?? '')
            .replace(new RegExp(vkMentionSource, 'giu'), replacement)
            .replace(
                new RegExp(
                    `(?<![\p{L}\p{N}_])${spokenBotNameSource}(?![\p{L}\p{N}_])`,
                    'giu',
                ),
                replacement,
            );
        const telegramExpression = getTelegramExpression('giu');

        if (telegramExpression) {
            source = source.replace(telegramExpression, replacement);
        }

        return source;
    };
    const removeBotMentions = (text) => replaceBotMentions(text, ' ')
        .replace(/^[\s,.!?;:—–-]+|[\s,.!?;:—–-]+$/gu, '')
        .replace(/\s{2,}/gu, ' ')
        .trim();

    return {
        vkMentionSource,
        containsBotMention,
        removeBotMentions,
        /**
         * Возвращает только варианты из ТОГО ЖЕ предложения, где реально
         * присутствует обращение к боту. Команда в соседнем предложении не
         * наследует обращение «Гигорейв».
         */
        getBotAddressedCommandCandidates(text) {
            const result = [];
            const seen = new Set();

            for (const sentence of splitCommandSentences(text)) {
                if (!containsBotMention(sentence)) continue;

                // Полное предложение без обращения покрывает обычное
                // «Гигорейв, <команда>» и «<команда>, Гигорейв».
                const stripped = removeBotMentions(sentence);
                const candidateSources = [stripped];

                // Также рассматриваем цельные левую/правую части вокруг
                // обращения. Поэтому команда может стоять с любой стороны
                // даже без запятой: «помощь Гигорейв» / «Гигорейв версия».
                // Это не перебор отдельных слов, поэтому обычная фраза вроде
                // «Гигорейв расскажи, что означает слово помощь» не станет
                // локальной командой «помощь».
                const marked = replaceBotMentions(sentence, ' ␞ ');
                candidateSources.push(
                    ...marked
                        .split('␞')
                        .map((item) => item.trim())
                        .filter(Boolean),
                );

                for (const candidateSource of candidateSources) {
                    for (const candidate of buildCommandSentenceCandidates(candidateSource)) {
                        if (seen.has(candidate)) continue;
                        seen.add(candidate);
                        result.push(candidate);
                    }
                }
            }

            return result;
        },
    };
}
