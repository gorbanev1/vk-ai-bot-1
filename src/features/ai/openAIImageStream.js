/**
 * Сборщик изображений из потоковых ответов: data URI, base64 и URL-кандидаты.
 */
import {
    extractOpenAIFinalText,
    extractOpenAIIncrementalText,
} from './openAIStream.js';

function flattenText(value) {
    if (typeof value === 'string') {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map(flattenText).join('');
    }

    if (value && typeof value === 'object') {
        return flattenText(
            value.text ?? value.content ?? value.delta ?? value.url ?? '',
        );
    }

    return '';
}

export function collectOpenAIImageCandidates(
    value,
    candidates = [],
    depth = 0,
    key = '',
) {
    if (depth > 10 || value == null) {
        return candidates;
    }

    if (typeof value === 'string') {
        const text = value.trim();
        const dataUrlExpression =
            /data:image\/([a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)/giu;

        for (const match of value.matchAll(dataUrlExpression)) {
            candidates.push({
                type: 'buffer',
                value: match[2].replace(/\s+/gu, ''),
                mimeType: `image/${match[1].toLowerCase()}`,
            });
        }

        const markdownUrlExpression =
            /!\[[^\]]*\]\(\s*(https?:\/\/[^)\s]+)\s*\)/giu;

        for (const match of value.matchAll(markdownUrlExpression)) {
            candidates.push({
                type: 'url',
                value: match[1],
            });
        }

        if (
            /^(?:https?:\/\/)/iu.test(text) &&
            /(?:image|png|jpe?g|webp|gif|download|cdn)/iu.test(text)
        ) {
            candidates.push({
                type: 'url',
                value: text,
            });
        }

        if (
            /(?:b64|base64|image|data)/iu.test(key) &&
            text.length > 1000 &&
            /^[a-z0-9+/=\r\n]+$/iu.test(text)
        ) {
            candidates.push({
                type: 'buffer',
                value: text.replace(/\s+/gu, ''),
                mimeType: '',
            });
        }

        return candidates;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            collectOpenAIImageCandidates(
                item,
                candidates,
                depth + 1,
                key,
            );
        }
        return candidates;
    }

    if (typeof value === 'object') {
        for (const [childKey, childValue] of Object.entries(value)) {
            collectOpenAIImageCandidates(
                childValue,
                candidates,
                depth + 1,
                childKey,
            );
        }
    }

    return candidates;
}

/**
 * Collects an image from OpenAI-compatible SSE chunks. router.cheap's
 * gpt-image-2 currently emits Markdown in choices[0].delta.content:
 * ![Image](data:image/png;base64,...). The data URL may be split across chunks,
 * so the collector keeps the complete delta text until the stream ends.
 */
export class OpenAIImageStreamCollector {
    constructor({ maxImageBytes }) {
        this.maxEncodedChars =
            Math.ceil(maxImageBytes * 4 / 3) + 2 * 1024 * 1024;
        this.accumulatedText = '';
        this.finalText = '';
        this.bestBufferCandidate = null;
        this.bestUrlCandidate = null;
        this.payloadCount = 0;
    }

    remember(value) {
        const candidates = collectOpenAIImageCandidates(value);

        for (const candidate of candidates) {
            if (
                candidate.type === 'buffer' &&
                (!this.bestBufferCandidate ||
                    candidate.value.length > this.bestBufferCandidate.value.length)
            ) {
                this.bestBufferCandidate = candidate;
            }

            if (candidate.type === 'url') {
                this.bestUrlCandidate = candidate;
            }
        }
    }

    push(payload) {
        this.payloadCount += 1;
        this.remember(payload);

        const incremental = extractOpenAIIncrementalText(payload);

        if (incremental && this.accumulatedText.length < this.maxEncodedChars) {
            const remaining = this.maxEncodedChars - this.accumulatedText.length;
            this.accumulatedText += incremental.slice(0, remaining);
        }

        const completed = flattenText(extractOpenAIFinalText(payload));

        if (completed) {
            this.finalText = completed.slice(0, this.maxEncodedChars);
            this.remember(this.finalText);
        }
    }

    finish() {
        this.remember(this.accumulatedText);
        this.remember(this.finalText);

        return {
            candidates: [
                ...(this.bestBufferCandidate ? [this.bestBufferCandidate] : []),
                ...(this.bestUrlCandidate ? [this.bestUrlCandidate] : []),
            ],
            answerText: (
                this.finalText.length > this.accumulatedText.length
                    ? this.finalText
                    : this.accumulatedText
            ).trim(),
            payloadCount: this.payloadCount,
            encodedCharacters:
                this.bestBufferCandidate?.value?.length ?? 0,
        };
    }
}
