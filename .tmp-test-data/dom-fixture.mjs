import fs from 'node:fs';
import { createVkChatEventScraper } from '../src/platforms/vk/vkChatEventScraper.js';
const j=JSON.parse(fs.readFileSync('data/parser-forensic-archives/2026-10-07T07-37-54-811Z_parser-all-clean_449cbd/chat-2000000014.raw-cache.json','utf8'));
for (const id of [70876,70882,70893]) {
  const input=j.items.find(x=>x.conversationMessageId===id); let saved;
  const scraper=createVkChatEventScraper({conversationUrl:'https://vk.ru/im?sel=c14',dataDirectory:'.tmp-test-data/dom-fixture',liveMonitor:false,analyzeMessageWithAi:async()=>({events:[]}),hydrateMessageEvidence:async()=>{throw new Error('NO API HYDRATION');}});
  await scraper.runFiniteManualPass({cachedItems:[input],disableHistoryBackfill:true,diagnostics:{cacheSource:({items})=>{saved=items;return '';},log:()=>{}},incrementalOnly:false});
  const x=saved?.[0]; console.log(JSON.stringify({id,rawRoot:input.rootPostText?.length,rawEmbedded:input.embeddedText?.length,normalizedRoot:x?.rootPostText?.length,normalizedEmbedded:x?.embeddedText?.length,normalizedResolved:x?.rootPostTextResolved,first:(x?.rootPostText||'').slice(0,90)}));
}
