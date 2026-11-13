import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {prepareLocalSwissEphemerisRuntime} from '../src/features/astrology/astrologyRuntimeFallback.js';

prepareLocalSwissEphemerisRuntime();
const {calculateJyotishPrashna}=await import('../src/features/astrology/ephemeris.js');
const start=performance.now();
const r=await calculateJyotishPrashna({
 date:new Date('2026-11-09T16:00:00.000Z'),
 periodReferenceDate:new Date('2026-11-09T16:00:00.000Z'),
 latitude:51.6608,longitude:39.2003,locationName:'Контрольная карта',timeZone:'Europe/Moscow'
});
const sec=performance.now()-start;
const tokenizerPrefix=process.env.ASTROLOGY_TOKENIZER_PREFIX||
 join(process.env.TEMP||'', 'gigorave-astro-tokenizer');
let encode=null;
try{
 const require=createRequire(join(tokenizerPrefix,'package.json'));
 const {getEncoding}=require('js-tiktoken');const encoding=getEncoding('o200k_base');
 encode=x=>encoding.encode(String(x)).length;
}catch{}
const fullJson=JSON.stringify(r.data);
const inputs={
 'Полный локальный JSON (без отступов)':fullJson,
 'Старый максимальный транспорт':r.gptPayloadLegacyBenchmark,
 'Новый структурированный полный JSON':r.gptPayloadMaximum,
 'Быстрый профиль':r.gptPayloadFast,
 'Сбалансированный профиль':r.gptPayloadBalanced,
 'Расширенный профиль':r.gptPayloadFull,
};
const rows=Object.entries(inputs).filter(([,v])=>typeof v==='string').map(([name,value])=>({
 name,bytes:Buffer.byteLength(value,'utf8'),characters:value.length,
 tokens_o200k_base:encode?encode(value):null
}));
const old=rows.find(x=>x.name==='Старый максимальный транспорт');
const structured=rows.find(x=>x.name==='Новый структурированный полный JSON');
const result={
 measuredAt:new Date().toISOString(),chart:'synthetic fixed Voronezh 2026-11-09T16:00:00Z',
 tokenizer:encode?'o200k_base (proxy for GPT-6; not provider billing)':'not-installed, tokens unmeasured',
 durationMs:Math.round(sec),schema:r.data.schema,structuredSchema:JSON.parse(r.gptPayloadMaximum).schema,
 swissConfirmed:r.data.engine.coreCalculationsUsedSwissFiles,auditComplete:r.audit.completeForDeclaredScope,
 localCounts:{bodies:r.data.bodies.length,houses:Object.keys(r.data.houseSystems).length,harmonics:Object.keys(r.data.harmonicCharts).length,
 vargas:Object.keys(r.data.classicalDivisionalCharts).length,bindus:r.data.ashtakavarga.total,stars:r.data.fixedStars.length,
 jaiminiRashiSigns:r.data.jaiminiTechnical.signAspects.length, vimshopakaSchemes:Object.keys(r.data.vimshopakaAllSchemes.weightSets).length,
 dashaPratyPeriods:JSON.parse(r.gptPayloadMaximum).vimshottari.praty.length},
 rows,
 tokenSavingsPct:old?.tokens_o200k_base&&structured.tokens_o200k_base?
  Math.round((1-structured.tokens_o200k_base/old.tokens_o200k_base)*10000)/100:null,
 notes:['Full local data remains in process memory; this report stores sizes only, no personal chart content.',
 'Token counts use the o200k_base proxy tokenizer; exact GPT-6/provider billing can differ.',
 'No GPT/provider request was made; this benchmark measures serialized prompt data locally.']
};
console.log('ASTROLOGY_TOKEN_BENCHMARK',JSON.stringify(result,null,2));
if(process.argv.includes('--save')){
 mkdirSync(resolve('reports'),{recursive:true});
 const location=resolve('reports/astrology-structured-token-benchmark-20261109.json');
 writeFileSync(location,JSON.stringify(result,null,2)+'\n');
 console.log('BENCHMARK_REPORT_SAVED',location);
}
if(!r.audit.completeForDeclaredScope||!r.data.engine.coreCalculationsUsedSwissFiles)
 throw Error('Benchmark cannot proceed without confirmed local Swiss calculation');
if(structured.bytes>fullJson.length*0.50)throw Error('Structured transport insufficiently compact');
