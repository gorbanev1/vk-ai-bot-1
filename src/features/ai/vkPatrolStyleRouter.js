/**
 * vkPatrolStyleRouter.js
 *
 * Detects aggression/negativity in an incoming message and optionally routes
 * the final answer through a local uncensored model (Ollama) instead of Luna.
 *
 * Rules:
 *   - If the message is flagged as aggressive AND Math.random() < CRUDE_ROUTE_RATIO
 *     → call Ollama for a short, unfiltered Russian reply
 *   - Otherwise → return null (caller uses Luna as normal)
 *
 * Completely isolated: no imports from botApplication, no side effects on the
 * agent loop. The only external dependency is Node's built-in `http`.
 */

import { request as httpRequest } from 'node:http';

// 1 out of 3 aggressive cases goes to Ollama
const CRUDE_ROUTE_RATIO = 1 / 3;
// Max parallel Ollama requests (protect CPU)
const MAX_PARALLEL_OLLAMA = 2;
let activeOllamaRequests = 0;

const OLLAMA_HOST = process.env.OLLAMA_HOST || '127.0.0.1';
const OLLAMA_PORT = Number(process.env.OLLAMA_PORT) || 11434;
const OLLAMA_MODEL = process.env.PATROL_CRUDE_MODEL || 'huihui_ai/qwen2.5-abliterate:7b';
const OLLAMA_TIMEOUT_MS = 25_000;

// ─── Aggression detector ────────────────────────────────────────────────────

// Explicit Russian profanity roots + aggressive imperative patterns.
// Intentionally narrow — false positives waste the crude slot.
const AGGRESSION_ROOTS = [
    // mat roots (partial, to cover inflections)
    'хуй', 'хуе', 'хуи', 'хуя', 'хую', 'хуём', 'нахуй', 'нахуе',
    'пизд', 'пиздец', 'пизд',
    'ебан', 'ёбан', 'еба', 'ёба', 'иди нахуй', 'идинахуй',
    'блядь', 'бля', 'блять',
    'сука', 'суки', 'суку', 'сучар',
    'мразь', 'мрази',
    'ублюдок', 'ублюдк',
    'шлюх', 'шалав',
    'дебил', 'дебилизм', 'дебильн',
    'мудак', 'мудил',
    'чмо', 'чмошник',
    'долбоёб', 'долбоеб', 'долбаёб', 'долбаеб',
    'залупа', 'залуп',
    'уёбищ', 'уебищ',
    'пошёл нахуй', 'иди нахуй',
    'сдохни', 'сдыхай',
    'заткнись', 'закройся',
    'тварь', 'твар',
    'урод', 'уродин',
    'говн', 'дерьм',
    'отстой', 'отстоин',
];

const AGGRESSION_RE = new RegExp(
    AGGRESSION_ROOTS.map(w => w.replace(/[.*+?^$()|[\]\\]/gu, '\\$&')).join('|'),
    'iu'
);

/**
 * Returns true when the message text looks aggressive / contains strong profanity.
 * @param {string} text
 * @returns {boolean}
 */
export function isAggressiveMessage(text) {
    return AGGRESSION_RE.test(String(text || ''));
}

// ─── Ollama caller ───────────────────────────────────────────────────────────

/**
 * Calls the local Ollama API synchronously via Node http (not fetch, so it
 * works in older Node versions without --experimental-fetch).
 *
 * @param {string} userMessage   The original question / message text
 * @param {string} botDraft      Luna's draft answer (used as context hint)
 * @returns {Promise<string|null>}  Short crude reply, or null on failure
 */
async function callOllamaCrude(userMessage, botDraft) {
    const body = JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        options: { temperature: 0.95, num_predict: 80 },
        messages: [
            {
                role: 'system',
                content:
                    'Ты участник грубого русского чата. Отвечай ОЧЕНЬ коротко — ' +
                    'максимум одно-два предложения. Мат и грубость — норма. ' +
                    'Не объясняй, не извиняйся. Просто отвечай в тему и грубо. ' +
                    'Если уместно — используй мат. Не выдумывай факты.',
            },
            {
                role: 'user',
                content: String(userMessage || '').slice(0, 600),
            },
            ...(botDraft
                ? [{
                    role: 'assistant',
                    content: '(черновик бота, можешь переформулировать грубее): ' +
                        String(botDraft).slice(0, 400),
                }]
                : []),
        ],
    });

    return new Promise((resolve) => {
        let req;
        const timer = setTimeout(() => { req?.destroy(); resolve(null); }, OLLAMA_TIMEOUT_MS);
        req = httpRequest(
            {
                hostname: OLLAMA_HOST,
                port: OLLAMA_PORT,
                path: '/api/chat',
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
                timeout: OLLAMA_TIMEOUT_MS,
            },
            (res) => {
                const chunks = [];
                res.on('data', c => { if (chunks.reduce((n,x)=>n+x.length,0)+c.length>65_536){res.destroy();return;} chunks.push(c); });
                res.on('end', () => {
                    clearTimeout(timer);
                    try {
                        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                        const text = String(data?.message?.content || data?.response || '').trim();
                        resolve(text.slice(0, 500) || null);
                    } catch {
                        resolve(null);
                    }
                });
                res.on('error', () => { clearTimeout(timer); resolve(null); });
            }
        );
        req.on('error', () => { clearTimeout(timer); resolve(null); });
        req.on('timeout', () => { req.destroy(); clearTimeout(timer); resolve(null); });
        req.write(body);
        req.end();
    });
}

// A tone rewrite must not introduce new links, VK mentions or protocol instructions.
export function isCrudeReplyAcceptable(reply,incomingText='',draft=''){
 const text=String(reply||'').trim();
 if(!text||text.length>500||/https?:\/\/|<\|(?:system|developer|assistant)\|>|(?:^|\n)\s*(?:system|developer):/iu.test(text))return false;
 const known=String(incomingText)+' '+String(draft);
 for(const mention of text.match(/\[id\d+\|[^\]]+\]|@(?:id\d+|[a-z0-9_]{5,})/giu)||[])if(!known.includes(mention))return false;
 return true;
}
// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Decide whether to override Luna's answer with a crude Ollama reply.
 *
 * Call this right before sending the final answer in handlePatrolAdaptive.
 *
 * @param {object} opts
 * @param {string} opts.incomingText   Raw text of the user's message
 * @param {string} opts.lunaDraft      Luna's verified answer draft
 * @param {boolean} [opts.enabled=true] Feature flag (can be overridden per-env)
 * @returns {Promise<string|null>}     Crude reply string if routed, null otherwise
 */
export async function maybeRouteToCrudeModel({ incomingText, lunaDraft, enabled = true } = {}) {
    if (!enabled) return null;
    if (!isAggressiveMessage(incomingText)) return null;
    if (Math.random() >= CRUDE_ROUTE_RATIO) return null;

    // Concurrency limit — skip if too many Ollama calls in flight
    if (activeOllamaRequests >= MAX_PARALLEL_OLLAMA) {
        console.log('[CRUDE] skipped (queue full, active:', activeOllamaRequests, ')');
        return null;
    }

    activeOllamaRequests++;
    console.log('[CRUDE] routing to Ollama (active:', activeOllamaRequests, ')');
    const start = Date.now();

    try {
        const reply = await callOllamaCrude(incomingText, lunaDraft);
        const elapsed = Date.now() - start;
        console.log('[CRUDE] completed in', elapsed, 'ms, reply length:', reply?.length || 0);
        return isCrudeReplyAcceptable(reply, incomingText, lunaDraft) ? reply : null;
    } catch (err) {
        console.warn('[CRUDE] error:', err.message);
        return null;
    } finally {
        activeOllamaRequests--;
    }
}
