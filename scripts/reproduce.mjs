import {mkdir,readFile,writeFile,access} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hash,saveJson,makeWireframes} from './experiment-preflight.mjs';
import {modelSpec,stages} from './experiment-runner.mjs';
import {extraSpec,runCohort} from './run-reproduction.mjs';
import {session,qualify,maybeJson,primaryModels} from './reproduction-session.mjs';
import {loadPaperModelProfiles,publicPaperModelProfile} from './paper-models.mjs';
import {Journal} from './experiment-journal.mjs';

const repo=dirname(dirname(fileURLToPath(import.meta.url)));
const args=process.argv.slice(2);
const value=flag=>{const i=args.indexOf(flag);return i<0?null:args[i+1];};
const root=resolve(value('--out')??join(repo,'runs','run-'+new Date().toISOString().replace(/[:.]/g,'-')));
process.chdir(repo);
if(args.includes('--help')){
 console.log('node scripts/reproduce.mjs --init --out RUN\nnode scripts/reproduce.mjs --dry-run --out RUN\nnode scripts/reproduce.mjs --check --out RUN\nnode scripts/reproduce.mjs --live --budget-cny 200 --confirm-prices --out RUN');
}else if(args.includes('--init')){
 try{await access(root);throw Error('Choose a new empty output directory');}catch(e){if(e.code!=='ENOENT')throw e;}
 await mkdir(join(root,'preflight','inputs'),{recursive:true});
 const images=await makeWireframes(join(root,'preflight','inputs'));
 const requirements=modelSpec+'\n'+extraSpec;
 await writeFile(join(root,'frozen-requirements.txt'),requirements+'\n'+JSON.stringify(stages,null,2));
 await writeFile(join(root,'.env.example'),'DASHSCOPE_API_KEY=\nDASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1\n');
 await saveJson(join(root,'init.json'),{schemaVersion:1,models:primaryModels,budgetCny:200,requirementsSha256:hash(requirements),stagesSha256:hash(JSON.stringify(stages)),wireframes:await Promise.all(images.map(async p=>({file:p.split(/[\\/]/).at(-1),sha256:hash(await readFile(p))}))),createdAt:new Date().toISOString()});
 console.log(JSON.stringify({initialized:root,modelCalls:0}));
}else{
 const initial=await maybeJson(join(root,'init.json'));if(!initial)throw Error('First use --init with a new --out directory');
 if(initial.requirementsSha256!==hash(modelSpec+'\n'+extraSpec)||initial.stagesSha256!==hash(JSON.stringify(stages)))throw Error('Frozen requirements changed; start a new run');
 for(const f of initial.wireframes)if(hash(await readFile(join(root,'preflight','inputs',f.file)))!==f.sha256)throw Error('Frozen wireframe changed');
 const profiles=await loadPaperModelProfiles({route:'bailian',preferLocalEnv:true,modelIds:primaryModels});
 const report={mode:args.includes('--live')?'live':args.includes('--check')?'check':'dry-run',out:root,models:Object.fromEntries(Object.entries(profiles).map(([k,v])=>[k,publicPaperModelProfile(v)])),repetitions:3,stages:8,repairsPerStage:2,budgetCny:200,modelCalls:0};
 if(!args.includes('--live')){await saveJson(join(root,'dry-run.json'),report);console.log(JSON.stringify(report));}
 else{
  if(value('--budget-cny')!=='200'||!args.includes('--confirm-prices'))throw Error('Live requires --budget-cny 200 --confirm-prices after checking official prices');
  if(Object.values(profiles).some(p=>!p.credential))throw Error('Fill the project .env using .env.example; keys never enter the run evidence');
  const s=await session(root);
  try{
   let q=await maybeJson(join(root,'qualification',s.authEpoch,'report.json'));if(q?.status!=='passed')q=await qualify(root,s);
   if(q.status!=='passed')throw Error('Current account qualification failed; see qualification report');
   const batches=[{id:'a',...primaryModels,thinking:8192,completion:40960},{id:'b',...primaryModels,thinking:16384,completion:65536},{id:'c',visual:'qwen3.8-max-0902',coder:'qwen3.7-max-2026-06-08',thinking:16384,completion:65536}];
   for(const c of batches){
    if(c.id==='c'){
     const p=await loadPaperModelProfiles({route:'bailian',preferLocalEnv:true,authEpoch:s.authEpoch,modelIds:c});
     const cs={...s,profiles:p,journal:await new Journal(root,p).init(),prefix:s.prefix+'-c',qualificationLabel:'c'};
     const cq=await qualify(root,cs);if(cq.status!=='passed')throw Error('Changed role qualification failed');
    }
    const result=await runCohort(root,s,c);if(result.successes)break;
   }
  }finally{await s.release();}
 }
}
