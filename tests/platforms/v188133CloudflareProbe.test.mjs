import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runCloudflareProbe, handleCfProbeCommand, parseCfProbeCommand } from '../../src/features/diagnostics/cloudflareProbe.js';

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const enc = new TextEncoder();
const response = (frames, status = 200) => ({
    ok: status >= 200 && status < 300, status, headers: { get: () => 'text/event-stream' },
    body: new ReadableStream({
        start(controller) { for (const frame of frames) controller.enqueue(enc.encode(frame)); controller.close(); },
    }),
});

test('probe command parsing and early owner-only Telegram routing', () => {
    assert.equal(parseCfProbeCommand('/cfprobe'), 'help');
    assert.equal(parseCfProbeCommand('/cfprobe@GigoraveBot stream'), 'stream');
    assert.equal(parseCfProbeCommand('проверь cfprobe'), null);
    assert.match(app, /parseCfProbeCommand\(originalText \|\| text\)/u);
    assert.match(app, /ownerDm: isOwnerContext\(context\) && privateMode/u);
    const first = app.indexOf('if (parseCfProbeCommand(originalText || text) !== null)');
    const second = app.indexOf('if (await maybeHandleAstraTextAttachmentIncoming(');
    assert.ok(first > 0 && second > first, 'probe route must run before GPT/file handling');
});

test('response bytes from one HTTP request: heartbeats separate from actual model data', async () => {
    const logs = []; let calls = 0;
    const frames = [': accepted\n\n', ': heartbeat\r\n\r\n', 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n'];
    const result = await runCloudflareProbe({ url: 'https://router.example.test/v1/chat/completions',
        payload: { model:'test', stream:true }, fetchImpl: async (...args) => { calls++; assert.equal(args[1].body.includes('"stream":true'), true); return response(frames); },
        log: line => logs.push(line),
    });
    assert.equal(calls, 1); assert.equal(result.status, 'COMPLETED');
    assert.equal(result.completed, true); assert.equal(result.heartbeatEvents, 2);
    assert.equal(result.modelDataEvents, 1); assert.equal(result.sseEvents, 4);
    assert.ok(result.bytes > 0); assert.equal(result.firstByteMs >= 0, true);
    assert.equal(logs.some(line=>line.includes('response-bytes')), true);
    assert.equal(logs.some(line=>line.includes('sse-heartbeat')), true);
});

test('truncated stream is UNKNOWN, no automatic second POST', async () => {
    let calls=0;
    const result = await runCloudflareProbe({ url:'https://router.example.test/v1/chat/completions',
        fetchImpl:async()=>{calls++;return response(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n']);},
    });
    assert.equal(result.status,'UNKNOWN_STREAM_END');assert.equal(result.completed,false);assert.equal(calls,1);
});

test('524 preserved as HTTP_ERROR without AI POST fallback', async () => {
    let calls=0;
    const result=await runCloudflareProbe({url:'https://router.example.test/v1/chat/completions',
        fetchImpl:async()=>{calls++;return response([],524);}});
    assert.equal(result.status,'HTTP_ERROR');assert.equal(result.httpStatus,524);assert.equal(calls,1);
});

test('non-owner and unconfirmed live probe never reach paid AI endpoint', async () => {
    let calls=0; const sent=[];
    const options={text:'/cfprobe live-stream',ownerDm:true,send:async t=>sent.push(t),
        baseUrl:'https://router.example.test/v1',apiKey:'TOPSECRET',model:'gpt-5.4-mini',fetchImpl:async()=>{calls++;return response([]);}};
    await handleCfProbeCommand({...options,ownerDm:false,text:'/cfprobe live-stream ПОДТВЕРЖДАЮ'});
    await handleCfProbeCommand(options);
    assert.equal(calls,0);
    assert.match(sent.join(' '),/ПОДТВЕРЖДАЮ/u);
});

test('live command performs exactly one confirmed streaming POST and never logs credentials or model output',async()=>{
    let calls=0;const sent=[];
    const result=await handleCfProbeCommand({text:'/cfprobe live-stream ПОДТВЕРЖДАЮ',ownerDm:true,
        send:async t=>sent.push(String(t)),baseUrl:'https://router.example.test/v1',apiKey:'VERYSECRET_API_KEY',
        model:'gpt-5.4-mini',fetchImpl:async(url,args)=>{
            calls++; assert.equal(url,'https://router.example.test/v1/chat/completions');
            assert.equal(args.headers.authorization,'Bearer VERYSECRET_API_KEY');
            assert.equal(JSON.parse(args.body).stream,true);
            return response(['data: {"choices":[{"delta":{"content":"VERYSECRET_MODEL_TEXT"}}]}\n\n','data: [DONE]\n\n']);
        },
    });
    assert.equal(result,true);assert.equal(calls,1);assert.match(sent.join('\n'),/COMPLETED/u);
    assert.equal(sent.join('\n').includes('VERYSECRET_API_KEY'),false);
    assert.equal(sent.join('\n').includes('VERYSECRET_MODEL_TEXT'),false);
});

test('unsafe URL cannot be probed; no network call is made',async()=>{
    let calls=0;
    const result=await runCloudflareProbe({url:'file:///etc/passwd',fetchImpl:async()=>{calls++;}});
    assert.equal(result.status,'SKIPPED');assert.equal(calls,0);
});

import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBodyProbe, runWsProbe, runAsyncProbe, runH2PingProbe } from '../../src/features/diagnostics/cloudflareProbeModes.js';
import { createServer } from 'node:http2';

test('complete ordinary HTTP response is not confused with incomplete SSE',async()=>{
    const r=await runCloudflareProbe({url:'https://test.example.com/probe/silent',expectSse:false,
        fetchImpl:async()=>({ok:true,status:200,headers:{get:()=> 'application/json'},
        body:new ReadableStream({start(c){c.enqueue(enc.encode('{"ok":true}'));c.close();}})})});
    assert.equal(r.status,'COMPLETED_HTTP');assert.equal(r.bytes,11);
});

test('optional request-body experiment starts exactly one test-origin POST',async()=>{
    let calls=0;
    const r=await runBodyProbe({url:'http://127.0.0.1/probe/body',
        runProbe:opts=>runCloudflareProbe({...opts,fetchImpl:async(_url,args)=>{
            calls++;assert.equal(args.duplex,'half'); assert.ok(args.body instanceof ReadableStream);
            return response(['data: [DONE]\n\n']);
        }}), send:async()=>{},log:async()=>{}});
    assert.equal(calls,1);assert.equal(r.status,'COMPLETED_HTTP');
});

test('async test endpoint uses exactly one POST then GETs the same job; never repeats POST',async()=>{
    const methods=[];
    const r=await runAsyncProbe({createUrl:'https://example.org/probe/jobs',
        statusUrlTemplate:'https://example.org/probe/jobs/{jobId}',
        fetchImpl:async(_url,args)=>{
            methods.push(args.method);
            return {ok:true,status:args.method==='POST'?202:200,
                json:async()=>args.method==='POST'?{jobId:'test_job_abcdef'}:{status:'completed'}};
        },log:async()=>{}});
    assert.deepEqual(methods,['POST','GET']); assert.equal(r.status,'COMPLETED');assert.equal(r.polls,1);
});

test('test-origin HTTP/2 POST can finish; PING is not labelled as SSE heartbeat',async()=>{
    const server=createServer();
    server.on('stream',(stream)=>{
        stream.on('data',()=>{});
        stream.on('end',()=>{stream.respond({':status':200,'content-type':'application/json'});stream.end('{"ok":true}');});
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const {port}=server.address();
    try {
        const r=await runH2PingProbe({url:`http://127.0.0.1:${port}/probe/silent`,log:async()=>{}});
        assert.equal(r.status,'COMPLETED_HTTP');assert.ok(r.bytes>0);assert.equal(r.httpStatus,200);
    } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('WS test is explicitly an application ping/pong, not a heartbeat for an HTTP POST',async()=>{
    class MockWS {
        listeners=new Map();
        constructor() {queueMicrotask(()=>this.emit('open',{}));}
        addEventListener(event,fn){this.listeners.set(event,fn);}
        emit(event,value){this.listeners.get(event)?.(value);}
        send(message){assert.equal(message,'ping');queueMicrotask(()=>this.emit('message',{data:'pong'}));}
        close(){}
    }
    const r=await runWsProbe({url:'wss://test.example.org/probe/ws',WebSocketCtor:MockWS,log:async()=>{}});
    assert.equal(r.status,'CONNECTED_APP_PONG');assert.equal(r.applicationPong,true);
});

test('all safe tests without server config skip everything, do not contact paid AI, send text log to Telegram',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'gigorave-cfprobe-'));
    let calls=0;const sent=[];const logs=[];
    try {
        await handleCfProbeCommand({text:'/cfprobe all',ownerDm:true,env:{GIGORAVE_TEXT_DATA_DIR:dir},
            send:async t=>sent.push(String(t)),sendLog:async txt=>logs.push(txt),
            fetchImpl:async()=>{calls++;return response([]);}});
        assert.equal(calls,0);assert.ok(sent.some(x=>x.includes('SKIPPED')));
        assert.equal(logs.length,1);assert.match(logs[0],/mode=async status=SKIPPED/u);
        assert.equal(logs[0].includes('Bearer '),false);
    } finally {await rm(dir,{recursive:true,force:true});}
});

test('all-live is gated by explicit confirmation; never starts multiple paid tests from help',async()=>{
    let calls=0;const sent=[];
    await handleCfProbeCommand({text:'/cfprobe all-live',ownerDm:true,baseUrl:'https://router.example.org/v1',apiKey:'SECRET',model:'mini',
        send:async msg=>sent.push(msg),fetchImpl:async()=>{calls++;return response([]);}});
    assert.equal(calls,0);assert.match(sent.join('\n'),/ДВА/u);
});
