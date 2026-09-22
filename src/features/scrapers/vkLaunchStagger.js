/**
 * Start-order gate, NOT a capture-completion gate.  A VK source can take a long
 * time to read its page, but this must not prevent the remaining configured
 * sources from opening at the requested randomized interval.
 *
 * Reserve slots synchronously in source order before awaiting any work.
 * `waitForLaunch()` resolves after the spacing delay and releases the next
 * reservation without waiting for this source's browser capture or AI work.
 */
export function createVkLaunchStagger({
    makeGapMs = () => 10_000 + Math.floor(Math.random() * 10_001),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onGap = () => {},
} = {}) {
    let priorLaunch = Promise.resolve();
    let reservedCount = 0;
    return function reserveVkLaunch(sourceId) {
        const predecessor = priorLaunch;
        const ordinal = reservedCount++;
        let releaseNext;
        priorLaunch = new Promise((resolve) => { releaseNext = resolve; });
        return (async () => {
            try {
                await predecessor;
                if (ordinal > 0) {
                    const gapMs = Number(makeGapMs());
                    if (!Number.isFinite(gapMs) || gapMs < 0) {
                        throw new Error('Invalid VK source launch gap');
                    }
                    onGap({ sourceId, gapMs, ordinal });
                    await sleep(gapMs);
                }
            } finally {
                // Never tie opening source N+1 to the end of source N capture.
                releaseNext();
            }
        })();
    };
}
