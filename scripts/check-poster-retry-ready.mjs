import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
for(const path of ['src/app/botApplication.js','src/infrastructure/database/index.js','src/infrastructure/database/parserPosterRetry.js','src/features/events/eventPosterMatching.js','src/features/scrapers/parserReplayEvidence.js','src/features/scrapers/parserPosterArchiveRepair.js','src/features/scrapers/parserWorkWorker.js','src/features/scrapers/parserAllRecovery.js','src/features/scrapers/parserErrorRecoveryPolicy.js','src/platforms/vk/vkPublicScraper.js','src/platforms/vk/vkChatEventScraper.js','src/platforms/telegram/telegramHtmlScraper.js']){
const r=spawnSync(process.execPath,['--check',path],{encoding:'utf8',windowsHide:true});if(r.status)throw Error(path+'\n'+r.stderr);
}console.log('SYNTAX OK');
const latest=new Map();
for(const line of readFileSync('data/logs/operations/2026-10-30.jsonl','utf8').split('\n'))try{const r=JSON.parse(line);if(r.operationId&&r.type?.startsWith('operation.')&&Date.parse(r.ts)>=Date.parse('2026-10-30T15:40:00Z'))latest.set(r.operationId,r);}catch{}
console.log('ACTIVE',JSON.stringify([...latest.values()].filter(r=>!/^operation\.(?:complete|completed|fail|failed|error|cancel|cancelled|stop|stopped|timeout|interrupted)(?:$|-)/.test(r.type)).map(r=>({type:r.type,name:r.operationName,ts:r.ts}))));
