/**
 * Настройки продвинутых GPT-режимов.
 *
 * Важно: эти поля являются пожеланием совместимому API. Если router не знает
 * reasoning_effort или verbosity, сетевой слой повторяет запрос без них, поэтому
 * pro-команда не ломается из-за несовместимого параметра.
 */
const PRO_MODES = Object.freeze(['pro', 'pro2', 'pro3']);

export function isProResponseMode(mode) {
    return PRO_MODES.includes(String(mode ?? ''));
}

export function getProInferenceControls(mode) {
    if (!isProResponseMode(mode)) {
        return Object.freeze({});
    }

    return Object.freeze({
        reasoningEffort: 'high',
        verbosity: 'high',
    });
}
