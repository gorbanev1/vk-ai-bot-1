export function isScraperTargetClosedError(error) {
    const text = String(error?.message ?? error ?? '').toLowerCase();
    return [
        'target page, context or browser has been closed',
        'target.createtarget',
        'failed to open a new tab',
        'browser has been closed',
        'browser context has been closed',
        'page has been closed',
        'context closed',
        'target closed',
    ].some((marker) => text.includes(marker));
}
