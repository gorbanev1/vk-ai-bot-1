/** One run's date-free pass only. Ordinary parser requests never use this policy. */
export function createDateFreeParserPolicy({ minimumSample = 4, onChange = () => {}, beforeAttempt = async () => {}, mode = 'default' } = {}) {
    const models = {};
    const requests = new Map();
    let stopped = false;
    const snapshot = () => ({ stopped, models: structuredClone(models), lunaFailureRatio: ratio(), terraFailureRatio: ratio('gpt-5.6-terra') });
    const ratio = (model = 'gpt-6-luna') => {
        const row = models[model];
        return row?.completed ? row.failures / row.completed : 0;
    };
    const failureThresholdReached = () =>
        (models['gpt-6-luna']?.completed >= minimumSample && ratio() >= 0.85) ||
        (models['gpt-5.6-luna']?.completed >= minimumSample && ratio('gpt-5.6-luna') >= 0.85) ||
        (models['gpt-5.6-terra']?.completed >= minimumSample && ratio('gpt-5.6-terra') >= 0.70);
    const stoppedError = () => Object.assign(new Error('Вторая фаза приостановлена: Luna достигла 85% отказов или Terra достигла 70%, затем по одной попытке 6.1 Sol и 6 Astra тоже завершились ошибкой. Остаток сохранён для продолжения.'), { code: 'DATE_FREE_PHASE_PAUSED' });
    let changeScheduled = false;
    function scheduleChange() {
        if (changeScheduled) return;
        changeScheduled = true;
        setTimeout(() => {
            changeScheduled = false;
            onChange(snapshot());
        }, 500).unref?.();
    }
    async function attempt(model, capability, request) {
        if (stopped) throw stoppedError();
        await beforeAttempt(capability);
        if (stopped) throw stoppedError();
        const row = models[model] ||= { attempts: 0, completed: 0, successes: 0, failures: 0, text: 0, vision: 0, totalMs: 0, capabilities: {} };
        const detail = row.capabilities[capability] ||= { attempts: 0, successes: 0, failures: 0, totalMs: 0, minMs: null, maxMs: 0 };
        detail.attempts++;
        row.attempts++; row[capability]++;
        const start = Date.now();
        try {
            const value = await request(model);
            row.successes++;
            detail.successes++;
            return value;
        } catch (error) {
            row.failures++;
            detail.failures++;
            // Persist the actual cause before the aggregate pause replaces it.
            detail.lastError = { code: String(error?.code || ''), message: String(error?.message || error).slice(0, 1500), at: new Date().toISOString() };
            row.lastError = detail.lastError;
            throw error;
        } finally {
            const duration = Date.now() - start;
            row.completed++; row.totalMs += duration;
            detail.totalMs += duration;
            detail.minMs = detail.minMs === null ? duration : Math.min(detail.minMs, duration);
            detail.maxMs = Math.max(detail.maxMs, duration);
            // A high junior failure rate is not itself a stop: the current
            // request must finish its bounded senior rescue attempts first.
            scheduleChange();
        }
    }
    async function runAttempts(capability, request) {
        let lastError;
        // Every ladder starts with GPT-6 Luna and spends exactly one attempt
        // there. If that first pass fails, retain the bounded legacy Luna
        // fallback before moving to Terra/Sol/Astra.
        if (stopped) throw stoppedError();
        try { return await attempt('gpt-6-luna', capability, request); }
        catch (error) { lastError = error; }
        for (let i = 0; i < 4; i++) {
            if (stopped) throw stoppedError();
            try { return await attempt('gpt-5.6-luna', capability, request); }
            catch (error) { lastError = error; }
        }
        if (stopped) throw stoppedError();
        // Luna's failure share no longer blocks Terra. Terra remains available
        // at >=50% failures, with up to four attempts on this same request.
        // Re-evaluate after each response: the first failed Terra call can
        // cross the threshold. Senior rescue follows only after these retries.
        for (let i = 0; i < (ratio('gpt-5.6-terra') >= 0.50 ? 4 : 1); i++) {
            if (stopped) throw stoppedError();
            try { return await attempt('gpt-5.6-terra', capability, request); }
            catch (error) { lastError = error; }
        }
        if (stopped) throw stoppedError();
        // Phase-two exception to the Terra ceiling: one attempt per senior,
        // no nested ordinary ladder. Success never changes the starting model
        // of the next request, which always starts at Luna above.
        for (const model of ['gpt-6.1-sol', 'gpt-6-astra']) {
            if (stopped) throw stoppedError();
            try { return await attempt(model, capability, request); }
            catch (error) { lastError = error; }
        }
        if (stopped || failureThresholdReached()) {
            stopped = true;
            onChange(snapshot());
            throw stoppedError();
        }
        // Preserve unresolved material after the bounded attempts. Every new
        // request starts from Luna again, never from a sticky Terra step.
        throw lastError;
    }
    return { mode, snapshot, run(capability, request, requestKey = '') {
        if (!requestKey) return runAttempts(capability, request);
        const key = `${capability}:${requestKey}`;
        if (!requests.has(key)) requests.set(key, runAttempts(capability, request));
        return requests.get(key);
    } };
}

export function formatDateFreePhaseReport(state, visionReport) {
    const images = visionReport?.images;
    return [
        'Вторая фаза — изображения без даты в тексте:',
        images ? `Картинок: ${images.planned}; распознано: ${images.recognized}; анонсов: ${images.announcements}; не анонсов: ${Math.max(0, images.recognized - images.announcements)}; не обработано: ${images.unprocessed}.` : '',
        ...Object.entries(state?.models || {}).flatMap(([model, row]) => Object.entries(row.capabilities || {}).map(([capability, stats]) =>
            `${model}, ${capability === 'vision' ? 'Vision' : 'текст'}: запросов ${stats.attempts}, успешно ${stats.successes}, отказов ${stats.failures}; среднее ${Math.round(stats.totalMs / Math.max(1, stats.successes + stats.failures) / 1000)} с, мин. ${Math.round((stats.minMs || 0) / 1000)} с, макс. ${Math.round(stats.maxMs / 1000)} с.`)),
        state?.stopped ? 'Вторая фаза приостановлена: Luna достигла 85% отказов или Terra достигла 70%; попытки 6.1 Sol и 6 Astra тоже не помогли. Остаток сохранён; можно продолжить по обычной лестнице или пропустить.' : '',
        'Лестница фазы 2: до 4 попыток Luna; Terra — 1 попытка, при доле отказов от 50% до 4; затем 6.1 Sol и 6 Astra — по 1 попытке. Каждый новый запрос начинается с Luna.',
    ].filter(Boolean).join('\n');
}

export function createParserAttemptPacer({ mode = 'default', gap, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, random = Math.random } = {}) {
    const next = new Map();
    const ranges = { turbo: [10_000, 15_000], turbo2: [7_000, 10_000], turbo3: [4_000, 6_000], turbo4: [2_000, 3_000] };
    const selected = ranges[String(mode || '').toLowerCase()];
    const nextGap = () => {
        if (typeof gap === 'function') return Math.max(0, Number(gap()) || 0);
        if (!selected) return 20_000;
        const [min, max] = selected;
        return Math.round(min + Math.max(0, Math.min(1, Number(random()) || 0)) * (max - min));
    };
    return async (capability) => {
        const start = Math.max(now(), next.get(capability) || 0);
        // Keep one global per-capability slot at the selected bounded interval.
        // The request may run longer; this limits starts without serialising
        // provider responses or changing retry semantics.
        next.set(capability, start + nextGap());
        const delay = start - now();
        if (delay > 0) await sleep(delay);
    };
}
