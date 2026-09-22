const TRANSIENT_LOAD_ERROR_RE = /(?:ошибка\s+(?:при\s+)?загруз|не\s+удалось\s+загруз|что[- ]?то\s+пошло\s+не\s+так|произошла\s+ошибка|попробуйте\s+(?:ещ[её]\s+раз|снова)|повторить\s+загруз|страница\s+(?:временно\s+)?недоступ|network\s+error|failed\s+to\s+load|something\s+went\s+wrong|try\s+again|reload\s+page)/iu;
const ACCESS_GATE_RE = /(?:captcha|капч|войдите\s+вконтакте|войти\s+вконтакте|подтвердите\s+вход|security\s+check|login\s+to\s+vk)/iu;

export function classifyVkSourcePageHealth({
    bodyText = '',
    postCount = 0,
    wallAnchorCount = 0,
    mainTextChars = 0,
    contentImageCount = 0,
    readyState = '',
} = {}) {
    const text = String(bodyText ?? '').replace(/\s+/gu, ' ').trim();
    const posts = Math.max(0, Number(postCount) || 0);
    const wallAnchors = Math.max(0, Number(wallAnchorCount) || 0);
    const mainChars = Math.max(0, Number(mainTextChars) || 0);
    const contentImages = Math.max(0, Number(contentImageCount) || 0);
    const accessGate = ACCESS_GATE_RE.test(text);
    if (accessGate) {
        return { ready: false, reload: false, reason: 'access-gate' };
    }
    if (TRANSIENT_LOAD_ERROR_RE.test(text)) {
        return { ready: false, reload: true, reason: 'load-error-text' };
    }
    if (posts > 0 || wallAnchors > 0) {
        return { ready: true, reload: false, reason: 'wall-content-present' };
    }
    // Changed VK markup can make exact post selectors temporarily return zero
    // while the actual page content is already rendered. Treat a substantial
    // main/content region with media as positive evidence and let adaptive /
    // heuristic parsing inspect that SAME DOM instead of destroying it by reload.
    if (mainChars >= 220 && contentImages > 0) {
        return { ready: true, reload: false, reason: 'rendered-content-present' };
    }
    const state = String(readyState ?? '').toLowerCase();
    if (state === 'complete' || state === 'interactive') {
        return { ready: false, reload: true, reason: 'empty-wall-dom' };
    }
    return { ready: false, reload: false, reason: 'still-loading' };
}
