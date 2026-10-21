import fs from 'node:fs';
const base = 'data/parser-forensic-archives';
for (const name of fs.readdirSync(base).filter(n => n.startsWith('2026-10-15T23') || n.startsWith('2026-10-16')).sort()) {
  const dir = base + '/' + name;
  const rows = fs.readFileSync(dir + '/trace.jsonl', 'utf8').trim().split(/\r?\n/).flatMap(l => {try{return [JSON.parse(l)];}catch{return [];}});
  console.log('RUN', name);
  for (const r of rows.filter(r => /^(?:run.processing.complete|run.partial-finalization|run.final-dedupe.*|run.finish|run.capture-or-start.error)$/.test(r.stage))) {
    const d = {...r.data}; delete d.results; delete d.message; delete d.summary;
    console.log(r.ts, r.stage, JSON.stringify(d));
  }
  const failures = rows.filter(r => r.stage === 'item.ai.text.selection' && r.data?.unresolved || r.stage === 'item.processing.rejected' || r.stage === 'item.processing.failed');
  console.log('FAILURES', failures.length);
  console.log(JSON.stringify(failures.map(r=>({at:r.ts,stage:r.stage,data:r.data}))).slice(0,9000));
}
const checkpoints = [];
for (const f of fs.readdirSync('data/operation-checkpoints').filter(n=>n.endsWith('.json'))) {
 try {const p=JSON.parse(fs.readFileSync('data/operation-checkpoints/'+f,'utf8'));const o=p.operation;
 if(o&&/parser/.test(o.name)&&o.startedAt>='2026-10-15T20') checkpoints.push({file:f,id:o.id,name:o.name,status:o.status,startedAt:o.startedAt,endedAt:o.finishedAt,error:o.error,phase:o.checkpoint?.phase,progress:o.progress,cp:{error:o.checkpoint?.error,unfinishedCandidates:o.checkpoint?.unfinishedCandidates,verificationSkipped:o.checkpoint?.verificationSkipped}});
 }catch{}
}
console.log('CHECKPOINTS',JSON.stringify(checkpoints.sort((a,b)=>a.startedAt.localeCompare(b.startedAt)).map(o=>({...o,progress:undefined}))));
