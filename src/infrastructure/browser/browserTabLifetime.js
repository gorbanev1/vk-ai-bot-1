export const BROWSER_TAB_MINIMUM_OPEN_MS = 15_000;

// Preventive, intentional dwell: leave time for a slow DOM to render and for
// the owner to reload/scroll manually. Native/manual tab closure is unaffected.
// Guard the shared context too: context.close() otherwise bypasses page.close().
export function createBrowserTabLifetime({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    const pages = new WeakMap();
    const contexts = new WeakSet();

    function protectPage(page, minimumOpenMs = BROWSER_TAB_MINIMUM_OPEN_MS, { restart = false } = {}) {
        let state = pages.get(page);
        if (!state) {
            state = { openedAt: now(), minimumMs: BROWSER_TAB_MINIMUM_OPEN_MS };
            pages.set(page, state);
            const close = page.close.bind(page);
            page.close = async (...args) => {
                await wait(page);
                if (!page.isClosed()) return close(...args);
            };
        }
        if (restart) state.openedAt = now();
        state.minimumMs = Math.max(state.minimumMs, Number(minimumOpenMs) || 0);
        return page;
    }

    async function wait(page) {
        const state = pages.get(page);
        if (!state) return;
        while (!page.isClosed()) {
            const remaining = state.openedAt + state.minimumMs - now();
            if (remaining <= 0) return;
            await new Promise(resolve => {
                let timer;
                const finish = () => {
                    clearTimer(timer);
                    page.off('close', finish);
                    resolve();
                };
                page.once('close', finish);
                timer = setTimer(finish, remaining);
                if (page.isClosed()) finish();
            });
        }
    }

    function protectContext(context) {
        if (contexts.has(context)) return context;
        contexts.add(context);
        context.on('page', page => protectPage(page));
        for (const page of context.pages()) protectPage(page);
        const close = context.close.bind(context);
        context.close = async (...args) => {
            // Include tabs opened while another tab was waiting for its dwell.
            while (true) {
                const active = context.pages().filter(page => !page.isClosed());
                for (const page of active) protectPage(page);
                await Promise.all(active.map(wait));
                if (context.pages().every(page => page.isClosed() ||
                    (pages.has(page) && now() >= pages.get(page).openedAt + pages.get(page).minimumMs))) break;
            }
            return close(...args);
        };
        return context;
    }
    return { protectPage, protectContext };
}

export const browserTabLifetime = createBrowserTabLifetime();
