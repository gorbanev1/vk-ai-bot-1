import fs from 'node:fs';
import { createVkChatEventScraper } from '../src/platforms/vk/vkChatEventScraper.js';
const j=JSON.parse(fs.readFileSync('../data/parser-forensic-archives/2026-10-07T07-37-54-811Z_parser-all-clean_449cbd/chat-2000000014.raw-cache.json','utf8'));
const logs=[]; let saved=[];
const s=createVkChatEventScraper({conversationUrl:'https://vk.ru/im?sel=c14',dataDirectory:'.tmp-test-data/dom-replay-2',liveMonitor:false,analyzeMessageWithAi:async()=>({events:[]}),hydrateMessageEvidence:async()=>{throw new Error('NO API HYDRATION');}});
const result=await s.runFiniteManualPass({cachedItems:j.items,disableHistoryBackfill:true,incrementalOnly:false,diagnostics:{cacheSource:({items})=>{saved=items;return '';},log:(e)=>logs.push(e)}});
console.log(JSON.stringify({result,root:saved.filter(x=>[70876,70882,70893].includes(x.conversationMessageId)).map(x=>({id:x.conversationMessageId,len:x.rootPostText?.length,resolved:x.rootPostTextResolved})),unresolved:logs.filter(x=>x.rootTextUnresolved||x.reasons?.includes?.('repost-root-text-unresolved')).map(x=>({item:x.itemId,reason:x.rootTextUnresolved,xreasons:x.reasons}))},null,2));
