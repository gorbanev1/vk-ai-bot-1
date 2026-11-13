/**
 * Scheduled parser runner.
 * Runs "парсер все новые 2фазы турбо4" daily at 01:45 Moscow time.
 */

let timer = null;
let lastRunDate = '';

export function startScheduledParser({
    intervalMs = 60000, // Check every minute
    initialDelayMs = 30000,
    logger = console,
    parserRunner = null, // function to run parser
} = {}) {
    if (timer) return timer;
    if (!parserRunner) throw new Error('parserRunner function required');

    logger.log('[SCHEDULED PARSER READY]', 'target-time=01:45 Moscow', 'command="парсер все новые 2фазы турбо4"');

    async function tick() {
        const now = new Date();
        const moscowTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
        const moscowHour = moscowTime.getHours();
        const moscowMinute = moscowTime.getMinutes();
        const todayKey = moscowTime.toISOString().slice(0, 10); // YYYY-MM-DD

        // Reset at midnight
        if (moscowHour === 0 && moscowMinute === 0 && lastRunDate !== todayKey) {
            lastRunDate = '';
        }

        // Run at 01:45 Moscow time, once per day
        if (moscowHour === 1 && moscowMinute === 45 && lastRunDate !== todayKey) {
            lastRunDate = todayKey;
            logger.log('[SCHEDULED PARSER START]', 'time=01:45 Moscow', 'date=' + todayKey);

            try {
                await parserRunner();
                logger.log('[SCHEDULED PARSER COMPLETED]', 'date=' + todayKey);
            } catch (e) {
                logger.error('[SCHEDULED PARSER FAILED]', String(e?.message || e).slice(0, 300));
            }
        }
    }

    timer = setInterval(() => void tick(), Math.max(10000, intervalMs));
    timer.unref?.();
    const starter = setTimeout(() => void tick(), Math.max(1000, initialDelayMs));
    starter.unref?.();
    return timer;
}

export function stopScheduledParser() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}
