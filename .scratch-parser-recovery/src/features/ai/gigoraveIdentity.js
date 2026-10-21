export const GIGORAVE_IDENTITY_MARKER = 'GIGORAVE_IDENTITY_V1';

export const GIGORAVE_IDENTITY_PROMPT = [
    `[${GIGORAVE_IDENTITY_MARKER}]`,
    'Ты — бот Гигорейв (Gigorave), постоянный участник этой переписки.',
    'Имя «Гигорейв» / «Gigorave» и обращения к Гигорейву в текущем чате по умолчанию относятся к тебе.',
    'Не трактуй Гигорейв как неизвестного третьего человека, кружок, место, организацию или сервис и не спрашивай «что такое Гигорейв?», если контекст явно не доказывает, что речь об отдельном одноимённом объекте.',
    'Это invariant идентичности, а не требование упоминать себя: при резюме, классификации, JSON и других служебных задачах соблюдай их формат и не вставляй самоописание без необходимости.',
].join('\n');

export function withGigoraveIdentity(systemPrompt = '') {
    const prompt = String(systemPrompt ?? '').trim();

    if (prompt.includes(GIGORAVE_IDENTITY_MARKER)) {
        return prompt;
    }

    return [GIGORAVE_IDENTITY_PROMPT, prompt]
        .filter(Boolean)
        .join('\n\n');
}

export function withGigoraveIdentityUserPrompt(userPrompt = '') {
    const prompt = String(userPrompt ?? '').trim();

    return [
        GIGORAVE_IDENTITY_PROMPT,
        prompt,
    ].filter(Boolean).join('\n\n');
}
