/**
 * Pure, side-effect-free routing hint: a project archive audit is NOT a request
 * to create a document, even if its instructions mention an "отчёт" or files.
 */
export function isProjectArchiveAuditCommand(value) {
    const text = String(value ?? '').normalize('NFKC').trim();
    const explicitlyRequestsArchiveAnalysis =
        /(?:проанализ|разбер|изуч)/iu.test(text) &&
        /(?:\bzip\b|\.zip\b|архив|проект|исходник)/iu.test(text);
    return Boolean(text &&
        /(?:^|\s)(?:astra|астра)(?:\s+(?:max|xhigh|high))?(?=[\s,.:!?]|$)/iu.test(text) &&
        (/(?:аудит|audit|проект|project|исправ|правк|рефактор|проверь|бот)/iu.test(text) ||
            explicitlyRequestsArchiveAnalysis));
}

export function isProjectArchiveAuditIntent(value) {
    const text = String(value ?? '').normalize('NFKC').trim();
    return Boolean(text &&
        /(?:аудит|audit|проверь|проанализируй|исправ|правк|рефактор)/iu.test(text) &&
        /(?:\bzip\b|\.zip\b|архив|исходник|исходн(?:ого|ый|ые)\s+код|проект|project)/iu.test(text));
}
