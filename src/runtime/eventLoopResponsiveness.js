import {monitorEventLoopDelay,performance} from 'node:perf_hooks';

const stages=new Map();
let ingress=0,ingressCommand=0,queueMaxMs=0,queuedSlow=0;
let enabled=false;

/** Short, synchronous duration only. No promise awaiting inside the measurement. */
export function measureSynchronousStage(name,fn){
 const begin=performance.now();
 try{return fn();}finally{
  const elapsed=performance.now()-begin;
  const previous=stages.get(name)||{count:0,totalMs:0,maxMs:0,over50:0};
  previous.count++;previous.totalMs+=elapsed;
  previous.maxMs=Math.max(previous.maxMs,elapsed);
  if(elapsed>=50)previous.over50++;
  stages.set(name,previous);
 }
}
export function recordVkIngressDispatch(delayMs,{interactive=false}={}){
 ingress++;if(interactive)ingressCommand++;
 const d=Number(delayMs)||0;
 queueMaxMs=Math.max(queueMaxMs,d);
 if(d>=200)queuedSlow++;
}
export function startEventLoopResponsivenessMonitor({intervalMs=15000,logger=console.warn}={}){
 if(enabled)return false;
 enabled=true;
 const histogram=monitorEventLoopDelay({resolution:20});histogram.enable();
 let lastWall=Date.now(),lastCpu=process.cpuUsage(),lastElu=performance.eventLoopUtilization(),cycles=0;
 const LONG_BLOCK_THRESHOLD_MS=2000;
 const handle=setInterval(()=>{
  const now=Date.now(),wallMs=Math.max(1,now-lastWall),cpu=process.cpuUsage(lastCpu);
  const util=performance.eventLoopUtilization(lastElu);
  const cpuPercent=Math.round(((cpu.user+cpu.system)/1000)/wallMs*100);
  const eventLoopMaxMs=Number.isFinite(histogram.max)?Math.round(histogram.max/1e6):0;
  const eventLoopP99Ms=Number.isFinite(histogram.percentile(99))?Math.round(histogram.percentile(99)/1e6):0;
  if(eventLoopMaxMs>=LONG_BLOCK_THRESHOLD_MS){
   let heap=null;
   try{heap=process.memoryUsage();}catch{}
   logger('[BOT LONG BLOCK]','delayMs='+eventLoopMaxMs,
    'heapRssMb='+(heap?Math.round(heap.rss/1048576):'-'),
    'heapUsedMb='+(heap?Math.round(heap.heapUsed/1048576):'-'),
    'externalMb='+(heap?Math.round(heap.external/1048576):'-'));
  }
  const top=[...stages.entries()].sort((a,b)=>b[1].totalMs-a[1].totalMs).slice(0,6)
   .map(([name,row])=>name+':count='+row.count+',sum='+row.totalMs.toFixed(0)+',max='+row.maxMs.toFixed(0));
  cycles++;
  if(eventLoopMaxMs>=120||queueMaxMs>=200||cpuPercent>=85||cycles%20===0){
   logger('[BOT RESPONSIVENESS]', 'periodMs='+wallMs,'loopMaxMs='+eventLoopMaxMs,'loopP99Ms='+eventLoopP99Ms,
    'utilPercent='+Math.round(util.utilization*100),'cpuCorePercent='+cpuPercent,
    'messages='+ingress,'interactive='+ingressCommand,'dispatchMaxMs='+Math.round(queueMaxMs),
    'dispatchOver200='+queuedSlow,'syncStages='+top.join('|'));
  }
  lastWall=now;lastCpu=process.cpuUsage();lastElu=performance.eventLoopUtilization();
  histogram.reset();stages.clear();ingress=0;ingressCommand=0;queueMaxMs=0;queuedSlow=0;
 },Math.max(1000,intervalMs));
 handle.unref?.();
 return true;
}
