import {spawnSync} from 'node:child_process';
for(const file of ['src/app/botApplication.js','src/features/ai/chatModelExperiment.js','src/features/personality/chatLearning.js','src/features/personality/chatLearningWorker.js','src/features/personality/botSelfDossier.js','src/features/routing/explicitApplicationCommand.js']){
 const r=spawnSync(process.execPath,['--check',file],{windowsHide:true,encoding:'utf8'});if(r.status)throw Error(file+' '+r.stderr);
}
console.log('SYNTAX OK');
