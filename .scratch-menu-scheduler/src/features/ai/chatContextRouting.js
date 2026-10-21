/**
 * Распознаёт запросы к истории чата: резюме, анализ всей конфы и связанные режимы.
 */
const CHAT_REFERENCE_PATTERNS = Object.freeze([
    // Чат и разговорные формы.
    /(?:^|[^\p{L}\p{N}_])чат(?:ик|ика|ике|ику|иком|ики|иков|икам|иками|иках|ец|ца|це|цу|цем|а|е|у|ом|ы|ов|ам|ами|ах)?(?=$|[^\p{L}\p{N}_])/iu,
    // Конфа, конф, конфочка, конфач, конфчат.
    /(?:^|[^\p{L}\p{N}_])конф(?:а|ы|е|у|ой|ою|ам|ами|ах|очка|очки|очке|очку|очкой|ач|ача|аче|ачу|ачем|чат|чата|чате|чату|чатом)?(?=$|[^\p{L}\p{N}_])/iu,
    // Распространённые сокращения «кф», «гч» и «групчат».
    /(?:^|[^\p{L}\p{N}_])(?:кф|гч|групп?чат)(?=$|[^\p{L}\p{N}_])/iu,
    // VK называет групповые чаты беседами; «беседка» часто используется разговорно.
    /(?:^|[^\p{L}\p{N}_])бесед(?:а|ы|е|у|ой|ою|ам|ами|ах|ка|ки|ке|ку|кой|кою|ках)?(?=$|[^\p{L}\p{N}_])/iu,
    /(?:^|[^\p{L}\p{N}_])переписк(?:а|и|е|у|ой|ою|ам|ами|ах)?(?=$|[^\p{L}\p{N}_])/iu,
    /(?:^|[^\p{L}\p{N}_])общени(?:е|я|ю|ем|и|ям|ями|ях)?(?=$|[^\p{L}\p{N}_])/iu,
    /(?:^|[^\p{L}\p{N}_])диалог(?:а|е|у|ом|и|ов|ам|ами|ах)?(?=$|[^\p{L}\p{N}_])/iu,
    /(?:^|[^\p{L}\p{N}_])разговор(?:а|е|у|ом|ы|ов|ам|ами|ах)?(?=$|[^\p{L}\p{N}_])/iu,
    /(?:^|[^\p{L}\p{N}_])(?:group\s*chat|groupchat|chat|convo|conversation|conf|gc)(?=$|[^\p{L}\p{N}_])/iu,
]);

const CURRENT_CONTEXT_MARKER = /(?:наш(?:а|ей|у|ем|и|их)|эт(?:а|ой|у|ом|и|их)|данн(?:ая|ой|ую|ом|ые|ых)|текущ(?:ая|ей|ую|ем|ие|их)|здешн(?:яя|ей|юю|ем|ие|их)|тут|здесь)/iu;
const CHAT_ANALYSIS_MARKER = /(?:сообщени|писал|писали|пишет|обсуждал|обсуждали|говорил|говорили|участник|истори|переписк|резюм|проанализ|итог|атмосфер|общени)/iu;
const AMBIGUOUS_GROUP_REFERENCE = /(?:конференц(?:ия|ии|ию|ией|ий|иям|иями|иях)|групп(?:а|ы|е|у|ой|ою|ам|ами|ах)|комнат(?:а|ы|е|у|ой|ою|ам|ами|ах))/iu;

const DIRECT_IMAGE_VERBS = /(?:^|[^\p{L}\p{N}_])(?:нарис(?:уй|уйте|овать)|изобраз(?:и|ите|ить)|проиллюстр(?:ируй|ируйте|ировать)|иллюстр(?:ируй|ируйте|ировать)|визуализ(?:ируй|ируйте|ировать)|отрис(?:уй|уйте|овать))(?=$|[^\p{L}\p{N}_])/iu;
const IMAGE_NOUNS = /(?:картин(?:ка|ку|ки|кой|ок|кам|ками|ках)?|изображени(?:е|я|ю|ем|й|ям|ями|ях)?|иллюстрац(?:ия|ии|ию|ией|ий|иям|иями|иях)?|арт(?:а|е|у|ом|ы|ов)?|мем(?:а|е|у|ом|ы|ов)?|постер(?:а|е|у|ом|ы|ов)?|комикс(?:а|е|у|ом|ы|ов)?|обложк(?:а|и|е|у|ой|ою)?|picture|image|illustration|poster|comic)/iu;
const IMAGE_CREATION_VERBS = /(?:сделай|сделайте|создай|создайте|сгенерируй|сгенерируйте|преврати|превратите|покажи|покажите|draw|illustrate|visuali[sz]e|generate|create)/iu;

export function containsCurrentChatReference(value) {
    const text = String(value ?? '').trim();

    if (!text) {
        return false;
    }

    const referenceText = text
        .replace(/(?:^|[^\p{L}\p{N}_])чат[-\s]?бот(?:а|е|у|ом|ы|ов|ам|ами|ах)?(?=$|[^\p{L}\p{N}_])/giu, ' ')
        .replace(/(?:^|[^\p{L}\p{N}_])chat[-\s]?bot(?=$|[^\p{L}\p{N}_])/giu, ' ');

    if (CHAT_REFERENCE_PATTERNS.some((pattern) => pattern.test(referenceText))) {
        return true;
    }

    // «Конференция», «группа» и «комната» двусмысленны. Считаем их текущей
    // перепиской только при явной ссылке на текущий контекст или сообщения.
    return AMBIGUOUS_GROUP_REFERENCE.test(referenceText) &&
        (CURRENT_CONTEXT_MARKER.test(referenceText) || CHAT_ANALYSIS_MARKER.test(referenceText));
}

export function isChatIllustrationRequest(value) {
    const text = String(value ?? '').trim();

    if (!text) {
        return false;
    }

    if (DIRECT_IMAGE_VERBS.test(text)) {
        return true;
    }

    return IMAGE_CREATION_VERBS.test(text) && IMAGE_NOUNS.test(text);
}

export function classifyChatContextRequest(value) {
    const usesChatDatabase = containsCurrentChatReference(value);

    return {
        usesChatDatabase,
        wantsImage:
            usesChatDatabase && isChatIllustrationRequest(value),
    };
}
