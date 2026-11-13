import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    recoverVkReplyAncestry, selectVkThreadImageSource,
    traceVkSourceChain, formatVkSourceChain, isVkSourceFollowup,
} from '../../src/features/ai/vkReplySourceRecovery.js';
const photo = url => ({type:'photo',photo:{sizes:[{width:1000,height:1000,url}]}});
test('retrieves all ancestor replies by VK ids and keeps first original image',async()=>{
    const messages = new Map([
        [19,{conversation_message_id:19,from_id:-100,text:'bot previous explanation',reply_message:{conversation_message_id:18}}],
        [18,{conversation_message_id:18,from_id:22,text:'initial problem',reply_message:{conversation_message_id:17}}],
        [17,{conversation_message_id:17,from_id:33,text:'original screenshot',attachments:[photo('https://test.example/origin.jpg')]}],
    ]);
    const requested=[];
    const root={conversation_message_id:20,from_id:22,text:'astra подробнее',reply_message:{conversation_message_id:19}};
    const full=await recoverVkReplyAncestry(root,{lookupByConversationMessageId:async cmid=>{requested.push(cmid);return messages.get(cmid)}});
    assert.deepEqual(requested,[19,18,17]);
    assert.equal(traceVkSourceChain(full).length,4);
    assert.deepEqual(selectVkThreadImageSource(full,{preference:'origin'}).urls,['https://test.example/origin.jpg']);
    assert.match(formatVkSourceChain(full),/PRIMARY_SOURCE/);
    assert.match(formatVkSourceChain(full),/bot previous explanation/);
    assert.match(formatVkSourceChain(full),/initial problem/);
    assert.equal(isVkSourceFollowup('астра xhigh подробнее'),true);
});
test('generation changes last image in same chain, not original',async()=>{
    const full={conversation_message_id:4,text:'поменяй фон',reply_message:{
        conversation_message_id:3,text:'generated',attachments:[photo('https://test.example/new.jpg')],
        reply_message:{conversation_message_id:2,attachments:[photo('https://test.example/original.jpg')]},
    }};
    assert.deepEqual(selectVkThreadImageSource(full,{preference:'latest'}).urls,['https://test.example/new.jpg']);
    assert.deepEqual(selectVkThreadImageSource(full,{preference:'origin'}).urls,['https://test.example/original.jpg']);
});
test('model pinned Astra, chain evidence on vision, and no silent text fallback',()=>{
    const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
    assert.match(app,/const pinnedAstra = initialModel === String\(configuredGptModels\.astra/u);
    assert.match(app,/const runtimeLadder = pinnedAstra\s*\? \[\{ model: initialModel, mode: 'astra', attempts: 2 \}\]/u);
    assert.match(app,/sourceThreadEvidence/u);
    assert.match(app,/resolveCompleteVkReplyThread\(rawContext\)/u);
    assert.match(app,/isVkSourceFollowup\(routeDecision\.explicitMode\?\.body \|\| routedRequestText\)/u);
});

test('forwarded message hydrates only from the same-peer archive',async()=>{
    const origin={peer_id:2000000006,conversation_message_id:100,from_id:55,text:'original screen error',attachments:[photo('https://test.example/screen.png')]};
    const current={peer_id:2000000006,conversation_message_id:102,from_id:66,text:'астра подробнее',
        fwd_messages:[{conversation_message_id:100,from_id:55,text:'original screen error'}]};
    let remoteCalls=0;
    const root=await recoverVkReplyAncestry(current,{
        peerId:2000000006,
        lookupLocalByConversationMessageId:async id=>id===100?origin:null,
        lookupByConversationMessageId:async()=>{remoteCalls++;return null;},
    });
    assert.equal(remoteCalls,0);
    assert.equal(traceVkSourceChain(root).length,2);
    assert.deepEqual(selectVkThreadImageSource(root,{preference:'origin'}).urls,['https://test.example/screen.png']);
    assert.match(formatVkSourceChain(root),/via=forwarded/u);
    assert.match(formatVkSourceChain(root),/original screen error/u);
    const foreign=await recoverVkReplyAncestry({
        peer_id:2000000006,conversation_message_id:105,from_id:66,
        fwd_messages:[{peer_id:2000000999,conversation_message_id:100,from_id:55,text:'original screen error',attachments:[photo('https://test.example/foreign.png')]}],
    },{peerId:2000000006,lookupLocalByConversationMessageId:async()=>origin});
    assert.deepEqual(selectVkThreadImageSource(foreign).urls,['https://test.example/foreign.png']);
    assert.doesNotMatch(formatVkSourceChain(foreign),/screen\.png/u);
});
test('archive collisions cannot replace the VK-supplied forwarded item',async()=>{
    const root=await recoverVkReplyAncestry({
        peer_id:2000000006,conversation_message_id:107,
        fwd_messages:[{conversation_message_id:100,from_id:999,text:'other chat'}],
    },{peerId:2000000006,lookupLocalByConversationMessageId:async()=>({
        conversation_message_id:100,from_id:55,text:'different text',attachments:[photo('https://test.example/real.jpg')],
    })});
    assert.equal(traceVkSourceChain(root).length,2);
    assert.match(formatVkSourceChain(root),/other chat/u);
    assert.deepEqual(selectVkThreadImageSource(root).urls,[]);
});

test('cross-chat forward stays in context but cannot hydrate from this chat archive',async()=>{
    let localLookups=0;
    const root=await recoverVkReplyAncestry({peer_id:2000000006,conversation_message_id:110,
        fwd_messages:[{peer_id:2000000999,conversation_message_id:100,from_id:55,text:'forwarded from another chat',attachments:[photo('https://test.example/forwarded.png'),],reply_message:{conversation_message_id:99}}]}, {
        peerId:2000000006,lookupLocalByConversationMessageId:async()=>{localLookups++;return {
            peer_id:2000000006,conversation_message_id:100,from_id:55,text:'different same-CMID record',attachments:[photo('https://test.example/archive.png')],
        };},lookupByConversationMessageId:async()=>{localLookups++;return {conversation_message_id:99};},
    });
    assert.equal(localLookups,0);
    assert.match(formatVkSourceChain(root),/forwarded from another chat/u);
    assert.deepEqual(selectVkThreadImageSource(root).urls,['https://test.example/forwarded.png']);
});

test('cross-chat forwards with a colliding CMID remain distinct in the source chain',async()=>{
    const root=await recoverVkReplyAncestry({peer_id:2000000006,conversation_message_id:111,text:'current',
        fwd_messages:[{peer_id:2000000999,conversation_message_id:111,from_id:55,text:'a separate forwarded message'}]},
        {peerId:2000000006});
    assert.equal(traceVkSourceChain(root).length,2);
    assert.match(formatVkSourceChain(root),/a separate forwarded message/u);
});
