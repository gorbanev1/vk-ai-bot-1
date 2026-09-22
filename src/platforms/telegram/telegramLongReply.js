/** Telegram delivery for already-generated text; no AI retry is performed here. */
export const TELEGRAM_LONG_REPLY_SAFE_LIMIT = 3500;

export function splitTelegramLongReply(value, limit = TELEGRAM_LONG_REPLY_SAFE_LIMIT) {
    const source = String(value ?? '');
    const maxLength = Number.isSafeInteger(limit) && limit >= 32 && limit <= 4000
        ? limit : TELEGRAM_LONG_REPLY_SAFE_LIMIT;
    if (!source) return [];
    const chunks = [];
    let offset = 0;
    while (source.length - offset > maxLength) {
        const candidateEnd = offset + maxLength;
        let end = candidateEnd;
        const startBoundary = offset + Math.floor(maxLength * 0.55);
        const newLine = source.lastIndexOf('\n', candidateEnd - 1);
        const space = source.lastIndexOf(' ', candidateEnd - 1);
        if (newLine >= startBoundary) end = newLine + 1;
        else if (space >= startBoundary) end = space + 1;
        // UTF-16 split must never separate a surrogate pair (emoji and others).
        if (end < source.length && end > offset &&
            source.charCodeAt(end - 1) >= 0xD800 && source.charCodeAt(end - 1) <= 0xDBFF &&
            source.charCodeAt(end) >= 0xDC00 && source.charCodeAt(end) <= 0xDFFF) end--;
        if (end <= offset) end = candidateEnd;
        chunks.push(source.slice(offset, end));
        offset = end;
    }
    if (offset < source.length) chunks.push(source.slice(offset));
    return chunks;
}

function telegramRetryAfter(error) {
    const data = error?.response?.body ?? error?.response?.data ?? error?.response ?? {};
    const parsed = typeof data === 'string' ? (() => { try { return JSON.parse(data); } catch { return {}; } })() : data;
    const value = Number(parsed?.parameters?.retry_after ?? error?.parameters?.retry_after ?? 0);
    const code = Number(error?.status ?? error?.statusCode ?? error?.response?.status ?? parsed?.error_code ?? 0);
    return code === 429 && Number.isFinite(value) && value > 0 && value <= 120 ? value : 0;
}

/** A 429 is a definitive rejection, hence its single retry is safe. For network
 * failures delivery is ambiguous: NEVER blindly resend the same Telegram part. */
export async function sendTelegramLongReply({ api, chatId, text, messageThreadId = null,
    replyMarkup = null, replyToMessageId = null, log = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    if (!api || typeof api.sendMessage !== 'function') throw new Error('Telegram sendMessage is unavailable');
    const parts = splitTelegramLongReply(text, TELEGRAM_LONG_REPLY_SAFE_LIMIT - 50);
    const messageIds = [];
    const record = (event, data) => { try { log(event, data); } catch {} };
    for (let i = 0; i < parts.length; i++) {
        const prefix = parts.length > 1 ? `Часть ${i + 1}/${parts.length}\n` : '';
        const chunk = prefix + parts[i];
        record('part-start', { part: i + 1, total: parts.length, chars: chunk.length });
        let sent;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                sent = await api.sendMessage({ chatId, text: chunk, messageThreadId,
                    replyMarkup, replyToMessageId: i === 0 ? replyToMessageId : null });
                break;
            } catch (error) {
                const seconds = attempt === 0 ? telegramRetryAfter(error) : 0;
                if (seconds > 0) {
                    record('rate-limited', { part: i + 1, retryAfterSec: seconds });
                    await sleep((seconds + 1) * 1000);
                    continue;
                }
                record('part-failed', { part: i + 1, total: parts.length,
                    sentParts: messageIds.length, code: String(error?.code ?? error?.status ?? error?.statusCode ?? '-') });
                error.telegramDelivery = { part: i + 1, total: parts.length,
                    sentParts: messageIds.length, messageIds: [...messageIds] };
                throw error;
            }
        }
        const messageId = Number(sent?.message_id ?? 0) || null;
        messageIds.push(messageId);
        record('part-sent', { part: i + 1, total: parts.length, chars: chunk.length, messageId });
    }
    return { parts: parts.length, messageIds };
}
