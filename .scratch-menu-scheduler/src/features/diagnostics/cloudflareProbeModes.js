/** Optional test-origin-only experiments. Never use an AI endpoint implicitly. */
import http2 from 'node:http2';

const time = () => Date.now();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const DURATION_MS = 210_000;

export function testEndpoint(value, { websocket = false } = {}) {
    if (!value) return null;
    try {
        const url = new URL(String(value));
        const allowed = websocket ? ['wss:'] : ['https:'];
        if (!allowed.includes(url.protocol)) {
            const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
            if (!local || !(websocket ? url.protocol === 'ws:' : url.protocol === 'http:')) return null;
        }
        if (url.username || url.password || url.hash) return null;
        return url;
    } catch { return null; }
}

export async function runBodyProbe({ url, runProbe, send, log, signal }) {
    if (!testEndpoint(url)) return { status:'SKIPPED', reason:'CF_PROBE_BODY_URL не настроен.' };
    // Whitespace after a complete JSON body is legal. However it is *request*
    // traffic, not HTTP response traffic, and cannot reset a response read timeout.
    let streamController;
    let interval;
    let closeTimer;
    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(interval); clearTimeout(closeTimer);
        try { streamController?.close(); } catch {}
    };
    const body = new ReadableStream({ start(controller) {
        streamController = controller;
        controller.enqueue(new TextEncoder().encode(JSON.stringify({probe:true,stream:true,mode:'body'})));
        interval = setInterval(() => {
            if (closed) return;
            try { controller.enqueue(new Uint8Array([32])); } catch { close(); }
            void log(`[${new Date().toISOString()}] request-body-byte: this is NOT a response heartbeat`).catch(() => {});
        }, 25_000);
        closeTimer = setTimeout(close, 185_000);
    }, cancel: close });
    signal?.addEventListener('abort', close, {once:true});
    try {
        const result = await runProbe({url, method:'POST', bodyOverride:body, expectSse:false,
            send, log, signal, durationMs:DURATION_MS });
        return result;
    } finally {
        signal?.removeEventListener('abort', close);
        close();
    }
}

export async function runH2PingProbe({ url, log = async()=>{}, signal = null }) {
    const target = testEndpoint(url);
    if (!target) return {status:'SKIPPED', reason:'CF_PROBE_H2_URL не настроен.'};
    const started = time();
    return new Promise(resolve => {
        let session;
        let request;
        let pingTimer;
        let timer;
        let settled = false;
        let pingCount = 0;
        let bytes = 0;
        let httpStatus = null;
        let firstByteMs = null;
        const finish = async (status, error = '') => {
            if (settled) return;
            settled = true;
            clearInterval(pingTimer); clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            try { request?.close(); } catch {}
            try { session?.close(); } catch {}
            try { session?.destroy(); } catch {}
            const result = {status, httpStatus, pingCount, bytes, firstByteMs, elapsedMs: time()-started};
            if (error) result.error = error;
            try { await log(`[${new Date().toISOString()}] h2-finished status=${status} http=${httpStatus ?? '-'} pings=${pingCount} bytes=${bytes} elapsedMs=${result.elapsedMs}`); } catch {}
            resolve(result);
        };
        const abort = () => { void finish('PROBE_CANCELLED'); };
        if (signal?.aborted) { void finish('PROBE_CANCELLED'); return; }
        signal?.addEventListener('abort', abort, {once:true});
        try {
            session = http2.connect(target.origin);
            session.on('error', error => void finish('UNKNOWN_EXCEPTION', String(error?.name || 'NetworkError')));
            session.on('close', () => { if (!settled) void finish('UNKNOWN_STREAM_END'); });
            request = session.request({ ':method':'POST', ':path':target.pathname+target.search,
                'content-type':'application/json', accept:'application/json' });
            request.on('response', headers => {
                httpStatus = Number(headers[':status']) || null;
            });
            request.on('data', chunk => {
                bytes += chunk.length;
                if (firstByteMs === null) firstByteMs = time()-started;
            });
            request.on('end', () => void finish(httpStatus >= 200 && httpStatus < 300 ? 'COMPLETED_HTTP' : 'HTTP_ERROR'));
            request.on('error', error => void finish('UNKNOWN_EXCEPTION', String(error?.name || 'NetworkError')));
            request.end(JSON.stringify({probe:true,mode:'h2ping',stream:false}));
            pingTimer = setInterval(() => {
                if (settled || session.destroyed) return;
                session.ping(error => {
                    if (!error) { pingCount++; void log(`[${new Date().toISOString()}] h2-ping-ack count=${pingCount}; this is NOT an AI response byte`).catch(()=>{}); }
                });
            }, 25_000);
            timer = setTimeout(() => void finish('PROBE_DEADLINE'), DURATION_MS);
        } catch (error) { void finish('UNKNOWN_EXCEPTION', String(error?.name || 'NetworkError')); }
    });
}

export async function runWsProbe({ url, log = async()=>{}, signal = null, WebSocketCtor = globalThis.WebSocket }) {
    const target = testEndpoint(url, {websocket:true});
    if (!target) return {status:'SKIPPED', reason:'CF_PROBE_WS_URL не настроен.'};
    if (typeof WebSocketCtor !== 'function') return {status:'SKIPPED', reason:'WebSocket API недоступен в установленной Node.js.'};
    const started = time();
    return new Promise(resolve => {
        let ws, timer, settled = false, opened = false, pong = false;
        const finish = async status => {
            if (settled) return;
            settled=true; clearTimeout(timer); signal?.removeEventListener('abort',abort);
            try { ws?.close(); } catch {}
            const result = {status, opened, applicationPong:pong, elapsedMs:time()-started};
            try { await log(`[${new Date().toISOString()}] ws-finished status=${status} opened=${opened} applicationPong=${pong}; does not test POST timeout`); } catch {}
            resolve(result);
        };
        const abort = () => void finish('PROBE_CANCELLED');
        if (signal?.aborted) { void finish('PROBE_CANCELLED'); return; }
        signal?.addEventListener('abort',abort,{once:true});
        try {
            ws = new WebSocketCtor(target.toString());
            ws.addEventListener('open', () => {
                opened=true;
                // Only a configured test service receives the application-level probe.
                try { ws.send('ping'); } catch { void finish('UNKNOWN_EXCEPTION'); }
            });
            ws.addEventListener('message', evt => {
                if (String(evt.data).trim().toLowerCase() === 'pong') {
                    pong=true; void finish('CONNECTED_APP_PONG');
                }
            });
            ws.addEventListener('error', () => void finish('UNKNOWN_EXCEPTION'));
            ws.addEventListener('close', () => { if (!settled) void finish(opened?'CONNECTED_NO_PONG':'UNKNOWN_EXCEPTION'); });
            timer=setTimeout(() => void finish(opened?'CONNECTED_NO_PONG':'PROBE_DEADLINE'), 15_000);
        } catch { void finish('UNKNOWN_EXCEPTION'); }
    });
}

export async function runAsyncProbe({createUrl,statusUrlTemplate,fetchImpl=fetch,log=async()=>{},send=async()=>{},signal=null}) {
    const create = testEndpoint(createUrl);
    if (!create || !String(statusUrlTemplate||'').includes('{jobId}')) return {status:'SKIPPED',reason:'Тестовые create/status endpoints не настроены.'};
    const started=time();
    const controller=new AbortController();
    const abort=()=>controller.abort();
    signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(abort,DURATION_MS);
    let jobId=''; let polls=0;
    try {
        const created=await fetchImpl(create.toString(),{method:'POST',redirect:'error',
            headers:{'content-type':'application/json',accept:'application/json'},
            body:JSON.stringify({probe:true,mode:'async',background:true}),signal:controller.signal});
        if (!created.ok) return {status:'HTTP_ERROR',httpStatus:created.status,elapsedMs:time()-started};
        const createPayload=await created.json();
        jobId=String(createPayload.jobId||createPayload.response_id||createPayload.id||'');
        if (!/^[a-zA-Z0-9_-]{6,160}$/u.test(jobId)) return {status:'NO_JOB_ID',elapsedMs:time()-started};
        await log(`[${new Date().toISOString()}] async-created jobId=${jobId} POSTs=1`);
        while (!controller.signal.aborted && polls < 35 && time()-started < DURATION_MS) {
            const statusUrl=testEndpoint(String(statusUrlTemplate).replace('{jobId}',encodeURIComponent(jobId)));
            if (!statusUrl || statusUrl.origin !== create.origin) return {status:'INVALID_STATUS_URL',jobId,polls};
            const statusResponse=await fetchImpl(statusUrl.toString(),{method:'GET',redirect:'error',
                headers:{accept:'application/json'},signal:controller.signal});
            polls++;
            if (!statusResponse.ok) return {status:'STATUS_HTTP_ERROR',httpStatus:statusResponse.status,jobId,polls};
            const payload=await statusResponse.json();
            const state=String(payload.status||payload.state||'unknown').toLowerCase();
            await log(`[${new Date().toISOString()}] async-get state=${state.slice(0,35)} jobId=${jobId} polls=${polls}`);
            if (['completed','failed','cancelled','canceled','error','incomplete'].includes(state)) {
                return {status:state.toUpperCase(),jobId,polls,elapsedMs:time()-started};
            }
            await sleep(5000);
        }
        return {status:controller.signal.aborted?'PROBE_DEADLINE':'UNKNOWN_STILL_RUNNING',jobId,polls,elapsedMs:time()-started};
    } catch(error) {
        return {status:controller.signal.aborted?'PROBE_DEADLINE':'UNKNOWN_EXCEPTION',jobId,polls,error:String(error?.name||'NetworkError').slice(0,60),elapsedMs:time()-started};
    } finally {
        clearTimeout(timer);signal?.removeEventListener('abort',abort);
    }
}
