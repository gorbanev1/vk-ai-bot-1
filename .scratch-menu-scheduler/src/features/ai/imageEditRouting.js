function compact(value) {
    return String(value ?? '')
        .replace(/\s+/gu, ' ')
        .trim();
}

const PREFIX_PATTERNS = Object.freeze([
    /^возьми\s+за\s+основу\s+и\s+дорисуй(?:\s+|$)/iu,
    /^дорисуй(?:\s+|$)/iu,
    /^доработай(?:\s+(?:это|эту|этот))?\s+(?:картинк(?:у|е)|изображени(?:е|я))(?:\s+|$)/iu,
    /^измени(?:\s+(?:это|эту|этот))?\s+(?:картинк(?:у|е)|изображени(?:е|я))(?:\s+|$)/iu,
    /^отредактируй(?:\s+(?:это|эту|этот))?\s+(?:картинк(?:у|е)|изображени(?:е|я))(?:\s+|$)/iu,
    /^расширь(?:\s+(?:это|эту|этот))?\s+(?:картинк(?:у|е)|изображени(?:е|я))(?:\s+|$)/iu,
    /^сделай\s+из\s+этого(?:\s+|$)/iu,
    /^(?:убери|удали|замени|поменяй|добавь|перекрась)(?:\s+|$)/iu,
    /^сделай\s+(?:фон|небо|цвет|волосы|одежду|кожу)(?:\s+|$)/iu,
]);

const ANYWHERE_PATTERN = /(?:возьми\s+за\s+основу\s+и\s+дорисуй|дорисуй|доработай\s+(?:картинк(?:у|е)|изображени(?:е|я))|измени\s+(?:картинк(?:у|е)|изображени(?:е|я))|отредактируй\s+(?:картинк(?:у|е)|изображени(?:е|я))|расширь\s+(?:картинк(?:у|е)|изображени(?:е|я))|(?:убери|удали|замени|поменяй|добавь|перекрась)\s+[^.!?]{1,120})/iu;

export function parseImageEditRequest(value) {
    const text = compact(value);

    if (!text) {
        return { matched: false, prompt: '', instruction: '' };
    }

    let matchedPrefix = '';

    for (const pattern of PREFIX_PATTERNS) {
        const match = text.match(pattern);
        if (match) {
            matchedPrefix = match[0];
            break;
        }
    }

    const matched = Boolean(matchedPrefix) || ANYWHERE_PATTERN.test(text);

    if (!matched) {
        return {
            matched: false,
            prompt: text,
            instruction: '',
        };
    }

    let instruction = matchedPrefix
        ? text.slice(matchedPrefix.length).trim()
        : text;

    if (!instruction) {
        instruction = 'Сохрани основную сцену и стиль исходного изображения, но аккуратно дорисуй и улучшай его по контексту запроса пользователя.';
    }

    return {
        matched: true,
        prompt: text,
        instruction,
    };
}
