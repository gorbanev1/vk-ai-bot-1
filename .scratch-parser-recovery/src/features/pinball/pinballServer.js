import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    getPinballLeaderboard,
    getPinballPersonalBest,
    savePinballScore,
} from '../../infrastructure/database/index.js';

const clean = (value) => String(value ?? '').trim();
const moduleDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const defaultStaticDir = resolve(moduleDir, '../../../miniapps/pinball');
const CONTENT_TYPES = Object.freeze({
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
    '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
});

function boundedInt(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function writeJson(response, status, payload) {
    const body = Buffer.from(JSON.stringify(payload));
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    });
    response.end(body);
}

function securityHeaders() {
    return {
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'permissions-policy': 'camera=(), microphone=(), geolocation=()',
        'cross-origin-opener-policy': 'same-origin',
        'content-security-policy': "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
    };
}

function parseJsonBody(request, maxBytes = 32 * 1024) {
    return new Promise((resolveBody, rejectBody) => {
        const chunks = [];
        let size = 0;
        request.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
                rejectBody(Object.assign(new Error('request body too large'), { statusCode: 413 }));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => {
            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                resolveBody(raw ? JSON.parse(raw) : {});
            } catch {
                rejectBody(Object.assign(new Error('invalid json'), { statusCode: 400 }));
            }
        });
        request.on('error', rejectBody);
    });
}

export function validateTelegramWebAppInitData(initData, botToken, { nowSec = Math.floor(Date.now() / 1000), maxAgeSec = 24 * 60 * 60 } = {}) {
    const raw = clean(initData);
    const token = clean(botToken);
    if (!raw || !token) return { ok: false, error: 'missing initData or bot token' };

    const params = new URLSearchParams(raw);
    const receivedHash = clean(params.get('hash'));
    if (!/^[a-f0-9]{64}$/iu.test(receivedHash)) return { ok: false, error: 'invalid hash' };
    params.delete('hash');
    params.delete('signature');
    const dataCheckString = [...params.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
    const secretKey = createHmac('sha256', 'WebAppData').update(token).digest();
    const calculated = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    try {
        const a = Buffer.from(receivedHash, 'hex');
        const b = Buffer.from(calculated, 'hex');
        if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: 'signature mismatch' };
    } catch {
        return { ok: false, error: 'signature mismatch' };
    }

    const authDate = Number(params.get('auth_date') || 0);
    if (!Number.isFinite(authDate) || authDate <= 0) return { ok: false, error: 'missing auth_date' };
    if (Math.abs(nowSec - authDate) > maxAgeSec) return { ok: false, error: 'initData expired' };

    let user = null;
    try { user = JSON.parse(params.get('user') || 'null'); } catch { user = null; }
    if (!user?.id) return { ok: false, error: 'missing user' };
    return { ok: true, authDate, user, queryId: clean(params.get('query_id')) };
}

function safeDisplayName(user = {}) {
    const first = clean(user.first_name);
    const last = clean(user.last_name);
    const username = clean(user.username);
    return clean([first, last].filter(Boolean).join(' ')) || (username ? `@${username}` : `Player ${String(user.id).slice(-5)}`);
}

function sanitizeLeaderboardRows(rows) {
    return rows.map((row) => ({
        name: clean(row.displayName) || (row.username ? `@${row.username}` : 'PLAYER'),
        score: Number(row.score || 0),
        maxCombo: Number(row.maxCombo || 0),
        jackpots: Number(row.jackpots || 0),
        createdAt: Number(row.createdAt || 0),
    }));
}

function validateScorePayload(body, session, nowMs) {
    const score = Number(body?.score);
    const durationMs = Number(body?.durationMs);
    const stats = body?.stats && typeof body.stats === 'object' ? body.stats : {};
    if (!Number.isInteger(score) || score < 0 || score > 2_000_000_000) return { ok: false, reason: 'invalid score' };
    if (!Number.isFinite(durationMs) || durationMs < 3_000 || durationMs > 3 * 60 * 60 * 1000) return { ok: false, reason: 'invalid duration' };
    const elapsed = Math.max(1_000, nowMs - session.startedAt);
    if (durationMs > elapsed + 120_000) return { ok: false, reason: 'duration exceeds session lifetime' };
    const scoreRate = score / Math.max(1, durationMs / 1000);
    if (scoreRate > 300_000) return { ok: false, reason: 'implausible score rate' };
    const maxCombo = boundedInt(stats.maxCombo, 0, 0, 500);
    const maxMultiplier = boundedInt(stats.maxMultiplier, 1, 1, 10);
    const bumpers = boundedInt(stats.bumpers, 0, 0, 100_000);
    const ramps = boundedInt(stats.ramps, 0, 0, 10_000);
    const jackpots = boundedInt(stats.jackpots, 0, 0, 2_000);
    const multiballs = boundedInt(stats.multiballs, 0, 0, 500);
    const nudges = boundedInt(stats.nudges, 0, 0, 100_000);
    return { ok: true, score, durationMs: Math.round(durationMs), stats: { maxCombo, maxMultiplier, bumpers, ramps, jackpots, multiballs, nudges } };
}

export function createPinballMiniAppServer({
    botToken = process.env.TELEGRAM_BOT_TOKEN,
    host = process.env.PINBALL_HTTP_HOST || '127.0.0.1',
    port = boundedInt(process.env.PINBALL_HTTP_PORT, 8787, 1, 65535),
    staticDir = defaultStaticDir,
    logger = console,
    maxInitDataAgeSec = boundedInt(process.env.PINBALL_INITDATA_MAX_AGE_SEC, 86400, 60, 604800),
} = {}) {
    const sessions = new Map();
    const scoreRate = new Map();
    let pruneTimer = null;

    function prune() {
        const t = Date.now();
        for (const [token, session] of sessions) if (t - session.lastSeenAt > 4 * 60 * 60 * 1000 || session.submitted) sessions.delete(token);
        for (const [key, row] of scoreRate) if (t - row.startedAt > 60_000) scoreRate.delete(key);
    }

    async function serveStatic(request, response, pathname) {
        let relative = pathname;
        if (relative === '/' || relative === '/pinball' || relative === '/pinball/') relative = '/index.html';
        else if (relative.startsWith('/pinball/')) relative = relative.slice('/pinball'.length);
        const normalized = decodeURIComponent(relative).replace(/\\/gu, '/').replace(/^\/+/, '');
        const absolute = resolve(staticDir, normalized || 'index.html');
        const root = resolve(staticDir);
        if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
            writeJson(response, 403, { error: 'forbidden' }); return;
        }
        let info;
        try { info = await stat(absolute); } catch { writeJson(response, 404, { error: 'not found' }); return; }
        if (!info.isFile()) { writeJson(response, 404, { error: 'not found' }); return; }
        const body = await readFile(absolute);
        const headers = securityHeaders();
        response.writeHead(200, {
            ...headers,
            'content-type': CONTENT_TYPES[extname(absolute).toLowerCase()] || 'application/octet-stream',
            'content-length': body.length,
            'cache-control': 'no-store, max-age=0',
            'pragma': 'no-cache',
            'expires': '0',
        });
        response.end(body);
    }

    const server = createServer(async (request, response) => {
        const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
        const pathname = requestUrl.pathname;
        try {
            if (request.method === 'GET' && (pathname === '/pinball/api/health' || pathname === '/api/health')) {
                writeJson(response, 200, { ok: true, service: 'gigorave-pinball', time: new Date().toISOString() }); return;
            }
            if (request.method === 'GET' && (pathname === '/pinball/api/leaderboard' || pathname === '/api/leaderboard')) {
                writeJson(response, 200, { rows: sanitizeLeaderboardRows(getPinballLeaderboard(15)), note: 'Онлайн-рекорды подтверждаются Telegram Mini App-сессией; клиентский античит носит базовый характер.' }); return;
            }
            if (request.method === 'POST' && (pathname === '/pinball/api/session' || pathname === '/api/session')) {
                const body = await parseJsonBody(request);
                const validation = validateTelegramWebAppInitData(body.initData, botToken, { maxAgeSec: maxInitDataAgeSec });
                if (!validation.ok) { writeJson(response, 401, { error: `Telegram auth failed: ${validation.error}` }); return; }
                const sessionToken = randomBytes(24).toString('base64url');
                const t = Date.now();
                sessions.set(sessionToken, { user: validation.user, startedAt: t, lastSeenAt: t, submitted: false });
                const personalBest = getPinballPersonalBest(String(validation.user.id));
                writeJson(response, 200, { sessionToken, user: { id: String(validation.user.id), username: clean(validation.user.username), firstName: clean(validation.user.first_name), displayName: safeDisplayName(validation.user) }, personalBest });
                return;
            }
            if (request.method === 'POST' && (pathname === '/pinball/api/score' || pathname === '/api/score')) {
                const body = await parseJsonBody(request);
                const token = clean(body.sessionToken);
                const session = sessions.get(token);
                if (!session || session.submitted) { writeJson(response, 401, { error: 'invalid or completed game session' }); return; }
                const key = String(session.user.id);
                const rate = scoreRate.get(key) || { startedAt: Date.now(), count: 0 };
                if (Date.now() - rate.startedAt > 60_000) { rate.startedAt = Date.now(); rate.count = 0; }
                rate.count += 1; scoreRate.set(key, rate);
                if (rate.count > 6) { writeJson(response, 429, { error: 'too many score submissions' }); return; }
                const checked = validateScorePayload(body, session, Date.now());
                if (!checked.ok) { writeJson(response, 200, { accepted: false, reason: checked.reason }); return; }
                session.submitted = true; session.lastSeenAt = Date.now();
                const save = savePinballScore({
                    sessionId: token,
                    telegramUserId: String(session.user.id),
                    username: clean(session.user.username),
                    displayName: safeDisplayName(session.user),
                    score: checked.score,
                    durationMs: checked.durationMs,
                    ...checked.stats,
                    createdAt: Math.floor(Date.now() / 1000),
                });
                const board = getPinballLeaderboard(100);
                const rankIndex = board.findIndex((row) => String(row.sessionId) === token);
                writeJson(response, 200, { accepted: Boolean(save.saved), rank: rankIndex >= 0 ? rankIndex + 1 : null, personalBest: getPinballPersonalBest(String(session.user.id)), rows: sanitizeLeaderboardRows(board.slice(0, 15)) });
                return;
            }
            if (request.method === 'GET' || request.method === 'HEAD') { await serveStatic(request, response, pathname); return; }
            writeJson(response, 405, { error: 'method not allowed' });
        } catch (error) {
            logger.error?.('[PINBALL HTTP ERROR]', error?.message || error);
            if (!response.headersSent) writeJson(response, Number(error?.statusCode || 500), { error: Number(error?.statusCode || 500) >= 500 ? 'internal error' : clean(error?.message) });
            else response.end();
        }
    });

    return {
        server,
        host,
        port,
        start() {
            if (server.listening) return Promise.resolve({ host, port });
            return new Promise((resolveStart, rejectStart) => {
                const onError = (error) => { server.off('listening', onListening); rejectStart(error); };
                const onListening = () => { server.off('error', onError); pruneTimer = setInterval(prune, 30 * 60 * 1000); pruneTimer.unref?.(); resolveStart({ host, port }); };
                server.once('error', onError); server.once('listening', onListening); server.listen(port, host);
            });
        },
        stop() {
            if (pruneTimer) clearInterval(pruneTimer);
            return new Promise((resolveStop) => server.close(() => resolveStop()));
        },
        get sessionCount() { return sessions.size; },
    };
}
