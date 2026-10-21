export const BEAUTIFUL_TIME_MODES = Object.freeze({
    TIME: 'time',
    DATE_TIME: 'date_time',
});

export function parseBeautifulTimeCommand(text) {
    let normalized = String(text || '').toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е').replace(/[^\p{L}\p{N}_@]+/gu, ' ').trim();
    normalized = normalized.replace(/^(?:гигорейв(?: бот)?|@gigorave_bot)\s+/u, '').trim();
    if (!normalized) return '';
    if (/^(?:фиксируй время стоп|фиксируй время откл|фиксируй время выкл|не фиксируй время|перестань фиксировать время|отключи фиксацию времени)$/u.test(normalized)) return 'stop';
    if (/^фиксируй (?:время и дату|дату и время)$/u.test(normalized)) return BEAUTIFUL_TIME_MODES.DATE_TIME;
    if (/^(?:фиксировать время|фиксируй время|отмечай время)$/u.test(normalized)) return BEAUTIFUL_TIME_MODES.TIME;
    return '';
}

const ORDINARY_EMOJIS = [
    '🌸', '🌺', '🌷', '🌹', '🌻', '🌼', '🪻', '🪷', '🍀', '🌿', '🍃', '🌱', '🌴', '🍁',
    '💧', '💦', '🫧', '🌊', '☀️', '🌙', '☁️', '🌈', '❄️', '🌧️', '🌬️', '⭐',
    '🦋', '🐝', '🐞', '🐬', '🐢', '🐚', '🦊', '🐱', '🐰', '🐼', '🦩', '🦚', '🐙',
    '🍓', '🍒', '🍋', '🍉', '🍇', '🍑', '🍍', '🍎', '🍄', '🍬', '🍭', '🧁',
    '🎈', '🎀', '🎁', '🎵', '🎶', '🎨', '🧸', '🪁', '🪩', '🪶', '🕯️', '🧿', '🪐',
    '🔥', '💣', '💥', '⚡', '✨', '💎', '🚀', '💫', '🌟', '☄️', '👑', '🎯',
];
const EXPRESSIVE_EMOJIS = ['🔥', '💣', '💥', '⚡', '🚀', '💎', '👑', '🌟', '✨', '💫', '☄️', '🌠', '🎯', '🏆', '🪄'];

function chooseEmoji(pool, random = Math.random) {
    return pool[Math.min(pool.length - 1, Math.floor(Math.max(0, random()) * pool.length))];
}

export function isBeautifulTime(hour, minute) {
    const value = `${String(hour).padStart(2, '0')}${String(minute).padStart(2, '0')}`;
    const counts = Object.values([...value].reduce((map, digit) => { map[digit] = (map[digit] || 0) + 1; return map; }, {}));
    const repeated = Math.max(...counts) >= 3 || value.slice(0, 2) === value.slice(2);
    const mirror = value[0] === value[3] && value[1] === value[2];
    const sequential = value === '0123' || value === '1234';
    const zeroPair = value[1] === '0' && value[3] === '0' && value[0] === value[2];
    const doublePairs = value === '1122' || value === '2211';
    return repeated || mirror || sequential || zeroPair || doublePairs;
}

export function isBeautifulDate(date) {
    const day = Number(date?.day);
    const month = Number(date?.month);
    const year = Number(date?.year);
    if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) return false;
    if (day < 1 || day > 31 || month < 1 || month > 12 || year < 1) return false;
    if (day === month) return true;

    const compact = String(day).padStart(2, '0') + String(month).padStart(2, '0') + String(year);
    const palindrome = compact === [...compact].reverse().join('');
    const repeatedNumber = new Set(compact).size <= 2 && new Set(compact).size < compact.length;
    const sequential = day <= 12 && month === day + 1 && year === 2002 + day;
    return palindrome || repeatedNumber || sequential;
}

export function zonedParts(timestamp, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(timestamp));
    const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return {
        year: Number(value.year), month: Number(value.month), day: Number(value.day),
        hour: Number(value.hour), minute: Number(value.minute), second: Number(value.second),
        dateKey: `${value.year}-${value.month}-${value.day}`,
    };
}

export function formatBeautifulTimeMessage({ date, time, beautifulDate, beautifulTime, mode, random = Math.random }) {
    const combined = beautifulDate && beautifulTime;
    const expressive = combined || mode === BEAUTIFUL_TIME_MODES.DATE_TIME;
    const emoji = chooseEmoji(expressive ? EXPRESSIVE_EMOJIS : ORDINARY_EMOJIS, random);
    const content = combined || mode === BEAUTIFUL_TIME_MODES.DATE_TIME
        ? `${String(date.day).padStart(2, '0')}.${String(date.month).padStart(2, '0')}.${date.year} ${time}`
        : beautifulDate && !beautifulTime
            ? `${String(date.day).padStart(2, '0')}.${String(date.month).padStart(2, '0')}.${date.year}`
            : time;
    return { emoji, message: `${emoji} ${content} ${emoji}` };
}

export function buildBeautifulTimeSchedule({ mode, timeZone, now = Date.now(), days = 2, random = Math.random }) {
    if (![BEAUTIFUL_TIME_MODES.TIME, BEAUTIFUL_TIME_MODES.DATE_TIME].includes(mode)) throw new Error('Unknown beautiful-time mode');
    if (!timeZone || !Number.isFinite(new Date(now).getTime())) throw new Error('A valid timezone and current timestamp are required');
    const start = Math.floor(now / 60_000) * 60_000 + 60_000;
    const end = start + (Math.max(1, days) + 1) * 27 * 60 * 60_000;
    const result = [];
    let lastDateKey = '';
    for (let timestamp = start; timestamp < end; timestamp += 60_000) {
        const local = zonedParts(timestamp, timeZone);
        const beautifulDate = isBeautifulDate(local);
        const beautifulTime = isBeautifulTime(local.hour, local.minute);
        const timeKey = `${local.dateKey}:${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`;
        if (mode === BEAUTIFUL_TIME_MODES.TIME && beautifulDate && local.hour === 0 && local.minute === 0 && local.dateKey !== lastDateKey && !beautifulTime) {
            const formatted = formatBeautifulTimeMessage({ date: local, time: '', beautifulDate: true, beautifulTime: false, mode, random });
            result.push({ id: `${local.dateKey}:date`, scheduledAt: timestamp, mode, date: local.dateKey, time: '00:00', beautifulDate, beautifulTime: false, ...formatted, status: 'scheduled' });
        }
        if (beautifulTime && (mode === BEAUTIFUL_TIME_MODES.TIME || beautifulDate)) {
            const time = `${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`;
            const formatted = formatBeautifulTimeMessage({ date: local, time, beautifulDate, beautifulTime: true, mode, random });
            result.push({ id: `${local.dateKey}:${time}:${mode}`, scheduledAt: timestamp, mode, date: local.dateKey, time, beautifulDate, beautifulTime, ...formatted, status: 'scheduled' });
        }
        lastDateKey = local.dateKey;
    }
    return result;
}

export function createBeautifulTimeScheduler({ loadState, saveState, send, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random }) {
    let timer = null;
    let ticking = false;

    const normalize = state => ({ version: 1, conversations: {}, ...(state && typeof state === 'object' ? state : {}) });
    const read = () => normalize(loadState());
    const write = state => saveState(normalize(state));

    function setConversation(key, conversation) {
        const state = read();
        state.conversations[key] = conversation;
        write(state);
    }

    function rebuild(key, conversation) {
        const history = [...(conversation.history || []), ...(conversation.queue || []).filter(job => ['sent', 'missed', 'failed', 'delivery_unknown'].includes(job.status))];
        conversation.history = history;
        const queue = buildBeautifulTimeSchedule({ mode: conversation.mode, timeZone: conversation.timeZone, now: now(), days: 2, random });
        conversation.queue = queue;
        conversation.lastPreparedAt = now();
        setConversation(key, conversation);
    }

    function arm() {
        if (timer) clearTimer(timer);
        timer = null;
        const state = read();
        const nextAt = Object.values(state.conversations).flatMap(chat => chat.queue || [])
            .filter(job => job.status === 'scheduled')
            .reduce((minimum, job) => Math.min(minimum, Number(job.scheduledAt)), Infinity);
        const nextRefreshAt = Object.values(state.conversations)
            .filter(chat => chat.mode)
            .reduce((minimum, chat) => Math.min(minimum, Number(chat.lastPreparedAt || 0) + 20 * 60 * 60_000), Infinity);
        const wakeAt = Math.min(nextAt, nextRefreshAt);
        if (!Number.isFinite(wakeAt)) return;
        timer = setTimer(() => { void tick(); }, Math.min(2_147_000_000, Math.max(0, wakeAt - now())));
        timer?.unref?.();
    }

    async function tick() {
        if (ticking) return;
        ticking = true;
        try {
            const state = read();
            const currentMinute = Math.floor(now() / 60_000) * 60_000;
            for (const [key, conversation] of Object.entries(state.conversations)) {
                if (!conversation.mode) continue;
                let changed = false;
                for (const job of conversation.queue || []) {
                    if (job.status !== 'scheduled' || Number(job.scheduledAt) > now()) continue;
                    if (Number(job.scheduledAt) < currentMinute) { job.status = 'missed'; job.actualSentAt = null; changed = true; continue; }
                    job.status = 'sending';
                    job.attemptedAt = now();
                    changed = true;
                    conversation.queue = conversation.queue;
                    setConversation(key, conversation);
                    try {
                        await send(conversation.target, job.message);
                        job.status = 'sent';
                        job.actualSentAt = now();
                        console.info('[BEAUTIFUL TIME SENT]', `conversation=${key}`, `job=${job.id}`, `scheduled=${job.scheduledAt}`, `sent=${job.actualSentAt}`);
                    } catch (error) {
                        job.status = 'failed';
                        job.error = String(error?.message || error).slice(0, 250);
                        console.error('[BEAUTIFUL TIME SEND ERROR]', `conversation=${key}`, `job=${job.id}`, job.error);
                    }
                    changed = true;
                }
                if (changed) setConversation(key, conversation);
                if (now() - Number(conversation.lastPreparedAt || 0) >= 20 * 60 * 60_000) rebuild(key, conversation);
            }
        } finally {
            ticking = false;
            arm();
        }
    }

    function start() {
        const state = read();
        for (const [key, conversation] of Object.entries(state.conversations)) {
            if (!conversation.mode) continue;
            const currentMinute = Math.floor(now() / 60_000) * 60_000;
            for (const job of conversation.queue || []) {
                if (job.status === 'sending') {
                    job.status = 'delivery_unknown';
                    job.error = 'Процесс завершился во время отправки; повтор отключён, чтобы избежать дубля.';
                } else if (job.status === 'scheduled' && Number(job.scheduledAt) <= currentMinute) {
                    job.status = 'missed';
                    job.actualSentAt = null;
                }
            }
            if (now() - Number(conversation.lastPreparedAt || 0) >= 20 * 60 * 60_000 || !conversation.queue?.some(job => job.status === 'scheduled' && Number(job.scheduledAt) > now())) rebuild(key, conversation);
            else setConversation(key, conversation);
        }
        void tick();
    }

    function activate(target, mode) {
        const key = `${target.platform}:${target.endpointKey || ''}:${target.peerId}:${target.threadId || ''}`;
        const existing = read().conversations[key];
        const history = [
            ...(existing?.history || []),
            ...(existing?.queue || []).filter(job => ['sent', 'missed', 'failed', 'delivery_unknown'].includes(job.status)),
        ];
        const conversation = { target, mode, timeZone: target.timeZone || existing?.timeZone || 'Europe/Moscow', history, queue: [] };
        rebuild(key, conversation);
        arm();
        return key;
    }

    function deactivate(target) {
        const state = read();
        const key = `${target.platform}:${target.endpointKey || ''}:${target.peerId}:${target.threadId || ''}`;
        const conversation = state.conversations[key];
        if (!conversation?.mode) return false;
        for (const job of conversation.queue || []) {
            if (['sent', 'missed', 'failed', 'delivery_unknown'].includes(job.status)) conversation.history.push(job);
            if (job.status === 'scheduled') job.status = 'cancelled';
        }
        conversation.mode = '';
        conversation.disabledAt = now();
        setConversation(key, conversation);
        arm();
        return true;
    }

    return { start, activate, deactivate, tick, rebuild, read };
}
