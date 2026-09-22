function compactText(value) {
    return String(value ?? '')
        .replace(/\s+/gu, ' ')
        .trim();
}

const EXPLICIT_IMAGE_PATTERNS = Object.freeze([
    /(?:^|\s)(?:что\s+на\s+(?:картинк(?:е|у)|фото|изображени(?:и|е)))(?:$|[\s?!.,:;])/iu,
    /(?:^|\s)(?:что\s+изображен(?:о|а))(?:$|[\s?!.,:;])/iu,
    /(?:^|\s)(?:что\s+тут\s+изображен(?:о|а))(?:$|[\s?!.,:;])/iu,
    /(?:^|\s)(?:опиши\s+(?:картинк(?:у|е)|фото|изображение))(?:$|[\s?!.,:;])/iu,
    /(?:^|\s)(?:проанализируй\s+(?:картинк(?:у|е)|фото|изображение))(?:$|[\s?!.,:;])/iu,
    /(?:^|\s)(?:разбери\s+(?:картинк(?:у|е)|фото|изображение))(?:$|[\s?!.,:;])/iu,
    /(?:^|\s)(?:оцени\s+(?:картинк(?:у|е)|фото|изображение))(?:$|[\s?!.,:;])/iu,
    /(?:^|\s)(?:прочитай\s+(?:текст\s+)?(?:на\s+)?(?:картинк(?:е|у)|фото|изображени(?:и|е)))(?:$|[\s?!.,:;])/iu,
]);

const CONTEXTUAL_VARIANT_PATTERNS = Object.freeze([
    /(?:^|\s)(?:предложи\s+вариант(?:ы|а)?)(?:$|[\s?!.,:;])/iu,
    /(?:^|\s)(?:какие\s+тут\s+вариант(?:ы|а)?)(?:$|[\s?!.,:;])/iu,
]);

export function isImageInspectionRequest(value) {
    const text = compactText(value);

    if (!text) {
        return false;
    }

    return [
        ...EXPLICIT_IMAGE_PATTERNS,
        ...CONTEXTUAL_VARIANT_PATTERNS,
    ].some((pattern) => pattern.test(text));
}

export function buildVisionTaskDescriptor(value) {
    const text = compactText(value);
    const explicitImageLanguage = EXPLICIT_IMAGE_PATTERNS.some(
        (pattern) => pattern.test(text),
    );
    const wantsVariants = CONTEXTUAL_VARIANT_PATTERNS.some(
        (pattern) => pattern.test(text),
    );

    return {
        matched: explicitImageLanguage || wantsVariants,
        prompt: text,
        explicitImageLanguage,
        requiresExistingImage: wantsVariants && !explicitImageLanguage,
        wantsVariants,
        wantsShortAnswer: /(?:коротко|кратко|вкратце)/iu.test(text),
    };
}

export const VISION_MODEL_MODE_ORDER = Object.freeze([
    'default',
    'gpt54',
    'gpt55',
    'pro',
    'pro2',
    'pro3',
    'astra',
]);

export function resolveVisionMode(value = 'vision-default') {
    const mode = String(value ?? '').trim();

    return VISION_MODEL_MODE_ORDER.includes(mode)
        ? mode
        : 'default';
}

export function getVisionModeChain(value = 'vision-default') {
    const mode = resolveVisionMode(value);
    const index = VISION_MODEL_MODE_ORDER.indexOf(mode);

    return VISION_MODEL_MODE_ORDER.slice(Math.max(0, index));
}
