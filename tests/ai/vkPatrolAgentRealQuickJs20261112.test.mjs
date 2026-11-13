import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';

test('actual isolated QuickJS worker loads persisted generated module and returns result to Luna',()=>{
 const dir=mkdtempSync(join(tmpdir(),'patrol-real-quickjs-'));
 const cwd=fileURLToPath(new URL('../../',import.meta.url));
 const script=[
  "import assert from 'node:assert/strict';",
  "import {DatabaseSync} from 'node:sqlite';",
  "process.execArgv=process.execArgv.filter(x=>!x.includes('input-type'));",
  "const db=new DatabaseSync(process.env.PATROL_TEST_DB);",
  "db.exec('CREATE TABLE stub (value TEXT)');db.close();",
  "const runner=await import(process.env.PATROL_RUNNER_URL);",
  "const pipe=await import(process.env.PATROL_PIPELINE_URL);",
  "assert.ok(runner.PATROL_MODULES_DIRECTORY.startsWith(process.env.GIGORAVE_DATA_DIR));",
  "const registry=pipe.createPatrolModuleRegistry({filename:process.env.PATROL_TEST_REGISTRY});",
  "const result=await pipe.buildPatrolModuleViaWorkers({",
  " name:'isolated_count',task:'Count supplied values',request:'Count my three items',",
  " input:{items:[1,2,3]},registry,",
  " listModules:runner.listPatrolModules,writeModule:runner.writePatrolModule,",
  " runModule:(name,input)=>runner.runPatrolModule(name,input,",
  "  {databasePath:process.env.PATROL_TEST_DB,timeoutMs:15000}),",
  " callCoder:async()=>({text:JSON.stringify({source:",
  "  'export async function run(api){return {ok:true,count:api.input.items.length}}'})}),",
  " evaluateCandidate:async proposal=>{assert.equal(proposal.output.count,3);",
  "  return {verdict:'satisfied',reason:'The real QuickJS runner returned count 3'};},",
  "});",
  "console.log('WORKER_RESULT',JSON.stringify(result));",
  "assert.equal(result.status,'sandbox-executed');",
  "assert.equal(result.output.count,3);",
  "assert.equal(registry.list().length,1);",
  "assert.ok(runner.listPatrolModules().some(x=>x.name==='isolated_count'));",
  "console.log('REAL_QUICKJS_SANDBOX_PASS');",
 ].join('\n');
 try{
  const scriptFile=join(dir,'isolated-quickjs-smoke.mjs');
  writeFileSync(scriptFile,script,'utf8');
  const run=spawnSync(process.execPath,['--no-warnings',scriptFile],{
   cwd,encoding:'utf8',timeout:60000,
   env:{...process.env,GIGORAVE_DATA_DIR:dir,PATROL_TEST_DB:join(dir,'sandbox.sqlite'),
    PATROL_RUNNER_URL:pathToFileURL(join(cwd,'src/features/ai/vkPatrolModuleRunner.js')).href,
    PATROL_PIPELINE_URL:pathToFileURL(join(cwd,'src/features/ai/vkPatrolAgentModulePipeline.js')).href,
    PATROL_TEST_REGISTRY:join(dir,'verified-registry.json')},
  });
  assert.equal(run.status,0,run.stdout+'\n'+run.stderr);
  assert.match(run.stdout,/REAL_QUICKJS_SANDBOX_PASS/u);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
