export function createPriorityIngressScheduler({
    interactiveConcurrency = 2,
    backgroundConcurrency = 1,
    onError = () => {},
} = {}) {
    const interactiveLimit = Math.max(1, Number(interactiveConcurrency) || 1);
    const backgroundLimit = Math.max(1, Number(backgroundConcurrency) || 1);
    const interactiveQueue = [];
    const backgroundQueue = [];
    let activeInteractive = 0;
    let activeBackground = 0;
    let scheduled = false;

    const scheduleDrain = () => {
        if (scheduled) return;
        scheduled = true;
        setImmediate(() => {
            scheduled = false;
            drain();
        });
    };

    const runEntry = (entry, interactive) => {
        if (interactive) activeInteractive++;
        else activeBackground++;
        let result;
        try {
            result = entry.run();
        } catch (error) {
            result = Promise.reject(error);
        }
        Promise.resolve(result).then(entry.resolve, error => {
            try { onError(error); } catch {}
            entry.reject(error);
        }).catch(() => {}).finally(() => {
            if (interactive) activeInteractive--;
            else activeBackground--;
            scheduleDrain();
        });
    };

    function drain() {
        while (activeInteractive < interactiveLimit && interactiveQueue.length) {
            runEntry(interactiveQueue.shift(), true);
        }
        while (activeBackground < backgroundLimit && backgroundQueue.length && !interactiveQueue.length) {
            runEntry(backgroundQueue.shift(), false);
        }
        if ((interactiveQueue.length || backgroundQueue.length) &&
            (activeInteractive < interactiveLimit || activeBackground < backgroundLimit)) {
            scheduleDrain();
        }
    }

    return {
        enqueue(run, { interactive = false } = {}) {
            if (typeof run !== 'function') throw new TypeError('Ingress task must be a function');
            const queue = interactive ? interactiveQueue : backgroundQueue;
            const promise = new Promise((resolve, reject) => {
                queue.push({ run, resolve, reject });
            });
            scheduleDrain();
            return promise;
        },
        async idle() {
            while (interactiveQueue.length || backgroundQueue.length || activeInteractive || activeBackground) {
                await new Promise(resolve => setImmediate(resolve));
            }
        },
        getStats() {
            return {
                interactiveQueued: interactiveQueue.length,
                backgroundQueued: backgroundQueue.length,
                activeInteractive,
                activeBackground,
            };
        },
        handleError(error) {
            try { onError(error); } catch {}
        },
    };
}
