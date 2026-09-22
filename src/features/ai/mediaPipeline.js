/**
 * Runs media items deterministically and never lets one broken attachment abort
 * the remaining chain. The caller decides how to log/report each failure.
 */
export async function processMediaItemsSequentially(items, processor, {
    onItemError = null,
} = {}) {
    const input = Array.isArray(items) ? items : [];
    const results = [];

    for (let index = 0; index < input.length; index += 1) {
        const item = input[index];
        try {
            results.push(await processor(item, index));
        } catch (error) {
            if (typeof onItemError === 'function') {
                try {
                    await onItemError(error, item, index);
                } catch {
                    // Error reporting must not turn a partial media failure into silence.
                }
            }
            results.push({
                ...item,
                status: 'failed',
                error: String(error?.message ?? error),
            });
        }
    }

    const processed = results.filter((item) => item?.status === 'processed').length;
    return {
        results,
        discovered: input.length,
        processed,
        failed: input.length - processed,
    };
}
