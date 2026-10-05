import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {session,maybeJson,qualify} from './reproduction-session.mjs';
import {Journal} from './experiment-journal.mjs';
import {modelSpec,stages,decodeHtml} from './experiment-runner.mjs';
import {inspectHtml} from './verify-experiment-app.mjs';
import {verifyReproduction} from './verify-reproduction.mjs';
import {hash,saveJson} from './experiment-preflight.mjs';
import {loadLocalSecretValues,loadPaperModelProfiles,publicPaperModelProfile} from './paper-models.mjs';
export const extraSpec=`Return ONLY a COMPLETE single HTML document, beginning <!doctype html> and ending </html>. Never JSON replacements or shell commands. Include a real head with exactly one CSP meta: default-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'. Keep this complete head in every stage and every repair.
Keep version 0.9.1 from Round1. The curve uses the full canvas CSS width with origin at width/2: each CSS x maps eta=(x-width/2)/(4*Dsim*Z); vertical plotting margins are allowed, horizontal plotting margins are NOT allowed. Draw dense curve using moveTo/lineTo/stroke, not an image. Grayscale pattern is a continuous monotonic gamma brightness profile (gamma .35..1.55). Draw in physical backing pixels or transform consistently for DPR. Both canvases must show a clear same-x vertical indicator when hovering the intensity canvas, and redraw on leave. Tooltip must include eta with >=4 decimals and I_N percentage with >=1 decimal. Home and arrows must change its values. Palettes must actually change the pattern colors, themes actual backgrounds.
Use marker CSS classes bright/dark (or data-kind), all markers in their container with count matching API, visually filled bright/hollow dark, percentage left=(value-min)/(max-min)*100. Dialog #principle-modal is an outer full-screen backdrop with >=12px padding; inner role=dialog contains #modal-close-button. Focus an inner control on opening, trap Tab AND Shift+Tab, return focus, Escape, close button and backdrop click close. Update rendering promptly after parameters change. No remote assets or runtime calls. Preserve all previous stage features. Do not include API credentials or any other program's code.
This is a current-model replication, not recovery of historical weights. Round0 is only visual semantic skeleton; no simulator JavaScript required. Later rounds implement only this trial's own code. Do not omit the head or closing html. Tests verify formula independently and inspect actual Canvas pixels, 18 Chromium combinations, focus and offline behavior.`;
const configurations=[{id:'a',visual:'qwen3.7-plus-2026-05-26',coder:'qwen3.8-max-0902',thinking:8192,completion:40960},{id:'b',visual:'qwen3.7-plus-2026-05-26',coder:'qwen3.8-max-0902',thinking:16384,completion:65536},{id:'c',visual:'qwen3.8-max-0902',coder:'qwen3.7-max-2026-06-08',thinking:16384,completion:65536}];
export async function runCohort(root,s,config){
 const dir=join(root,'formal','batch-'+config.id);await mkdir(dir,{recursive:true});
 const profiles=await loadPaperModelProfiles({route:'bailian',preferLocalEnv:true,authEpoch:s.authEpoch,modelIds:{visual:config.visual,coder:config.coder}});
 const journal=await new Journal(root,profiles,{category:'formal'}).init();
 const secrets=await loadLocalSecretValues();
 const wireframe=join(root,'preflight','inputs','wireframe-1.png');
 const verifierFiles=['verify-reproduction.mjs','verify-experiment-app.mjs','experiment-oracle.mjs','fixed-playwright.mjs'];
 const freeze={configuration:config,models:Object.fromEntries(Object.entries(profiles).map(([k,v])=>[k,publicPaperModelProfile(v)])),requirements:hash(modelSpec+extraSpec),stages:hash(JSON.stringify(stages)),wireframe:hash(await readFile(wireframe)),verifiers:Object.fromEntries(await Promise.all(verifierFiles.map(async f=>[f,hash(await readFile(join('scripts',f)))]))),repetitions:3,repairsPerStage:2,manualProgramEdits:0};
 const previous=await maybeJson(join(dir,'freeze.json'));if(previous&&JSON.stringify(previous)!==JSON.stringify(freeze))throw Error('Frozen cohort configuration changed');
 await saveJson(join(dir,'freeze.json'),freeze);await writeFile(join(dir,'frozen-requirements.txt'),modelSpec+'\n'+extraSpec+'\n'+JSON.stringify(stages));
 const summary={batch:config.id,status:'running',freeze,trials:[]};
 const summaryPath=join(dir,'summary.json');
 const persist=()=>saveJson(summaryPath,summary);
 try{
  for(let trial=1;trial<=3;trial++){
   const trialDir=join(dir,'trial-'+trial);await mkdir(trialDir,{recursive:true});
   const trialPath=join(trialDir,'trial.json');let t=await maybeJson(trialPath);
   if(t?.status==='passed'||t?.status==='failed'){summary.trials.push(t);await persist();continue;}
   t={trial,status:'running',manualProgramEdits:0,modelRepairs:0,stages:[]};summary.trials.push(t);await persist();
   let current='';
   for(let round=0;round<8;round++){
    const stageDir=join(trialDir,'round-'+round);await mkdir(stageDir,{recursive:true});
    const stagePath=join(stageDir,'stage.json'),saved=await maybeJson(stagePath);
    if(saved?.status==='finished'){t.stages.push(saved);t.modelRepairs+=saved.modelRepairs;if(saved.safeSnapshot){current=await readFile(join(stageDir,saved.safeSnapshot),'utf8');if(hash(current)!==saved.safeHash)throw Error('Snapshot changed during resume');}if(saved.terminal){t.status='failed';t.reason=saved.reason;break;}continue;}
    const stage={round,status:'running',attempts:[],modelRepairs:0};let draft=current,terminal=false;
    for(let attempt=0;attempt<=2;attempt++){
     if(attempt){stage.modelRepairs++;t.modelRepairs++;}
     const prefix=s.prefix+'-'+config.id+'-t'+trial+'-r'+round+'-a'+attempt,role=round===0?'visual':'coder';
     const evidence=stage.attempts.at(-1)??null;
     const messages=[{role:'system',content:modelSpec+'\n'+extraSpec},{role:'user',content:`Trial ${trial}, Round ${round}, attempt ${attempt}. Task: ${stages[round]}\n${draft?'THIS TRIAL CURRENT OR REJECTED DRAFT (text only):\n'+draft:'Start from a blank document; no previous program.'}\n${evidence?'Failure evidence: '+JSON.stringify(evidence):''}\nReturn the entire corrected safe HTML document, not a patch.`}];
     const a={attempt,callId:prefix+'-generate',status:'generating'};stage.attempts.push(a);await saveJson(stagePath,stage);await persist();
     console.log(JSON.stringify({batch:config.id,trial,round,attempt,event:'generate'}));
     let result;
     try{result=await journal.call(a.callId,role,{messages,imagePaths:round===0?[wireframe]:undefined,maxCompletionTokens:round===0?16384:config.completion,enableThinking:round!==0,thinkingBudget:round===0?undefined:config.thinking,stream:true,timeoutMs:600000});}
     catch(e){const record=await maybeJson(join(root,'calls',a.callId+'.json'));a.status=record?.status??'not-called';a.failure=e.message;a.evidence=record?.evidence;await saveJson(stagePath,stage);if(record?.status==='unknown'||!record||record.evidence?.httpStatus===403||record.evidence?.httpStatus===401)throw e;if(attempt===2){terminal=true;stage.reason='No completed generation after maximum repairs';}continue;}
     a.requestId=result.requestId;a.finishReason=result.finishReason;a.responseHash=hash(result.content);
     try{draft=decodeHtml(result.content);}catch(e){a.status='parse-failed';a.failure=e.message;await saveJson(stagePath,stage);if(attempt===2){terminal=true;stage.reason='No complete HTML after maximum repairs';}continue;}
     const file='attempt-'+attempt+'.html';await writeFile(join(stageDir,file),draft);a.snapshot=file;a.htmlHash=hash(draft);
     const issues=inspectHtml(draft,secrets);a.safetyIssues=issues;
     if(issues.length){a.status='unsafe-not-executed';await saveJson(stagePath,stage);if(attempt===2){terminal=true;stage.reason='Safety gate exhausted two repairs';}continue;}
     current=draft;stage.safeSnapshot=file;stage.safeHash=hash(current);
     const tests=await verifyReproduction(join(stageDir,file),join(stageDir,'test-'+attempt),{round,secrets});a.testPassed=tests.passed;a.failures=tests.checks.filter(c=>!c.passed);a.status='tested';await saveJson(stagePath,stage);
     const screen=tests.screenshots.find(s=>s.file.startsWith('desktop'))??tests.core?.screenshots?.find(s=>s.file.startsWith('desktop'));
     let review={passed:false,issues:['No screenshot available']};
     if(screen){const imagePath=tests.screenshots.includes(screen)?join(stageDir,'test-'+attempt,screen.file):join(stageDir,'test-'+attempt,'core',screen.file);
      const reviewId=prefix+'-review';a.reviewCall=reviewId;
      try{const r=await journal.call(reviewId,'visual',{messages:[{role:'user',content:`Review this Chinese double-slit teaching simulator Round ${round}. Only judge visible layout, labels, readability and overlap; no guessing of numerical correctness or future stage requirements. Round0 empty canvas skeleton is expected. Later require visible pattern and curve. Return only JSON {"passed":true|false,"issues":["specific visible issue"]}.`}],imagePaths:[imagePath],maxCompletionTokens:2048,enableThinking:false,stream:true,timeoutMs:240000});const v=JSON.parse(r.content.match(/\{[\s\S]*\}/)?.[0]);if(typeof v.passed!=='boolean'||!Array.isArray(v.issues))throw Error('Malformed review JSON');review=v;}
      catch(e){const record=await maybeJson(join(root,'calls',reviewId+'.json'));review={passed:false,issues:[e.message],status:record?.status??'format-failed'};if(record?.status==='unknown'||!record||record.evidence?.httpStatus===403)throw e;}
     }
     a.review=review;await saveJson(join(stageDir,'review-'+attempt+'.json'),review);await saveJson(stagePath,stage);
     if(tests.passed&&review.passed){a.status='passed';stage.passed=true;break;}
    }
    stage.status='finished';stage.passed=stage.passed??false;stage.terminal=terminal||!current;if(stage.terminal&&!stage.reason)stage.reason='No safe runnable program';await saveJson(stagePath,stage);t.stages.push(stage);await saveJson(trialPath,t);await persist();
    if(stage.terminal){t.status='failed';t.reason=stage.reason;break;}
   }
   if(t.status==='running'){
    const finalFile=join(trialDir,'final.html');await writeFile(finalFile,current);const final=await verifyReproduction(finalFile,join(trialDir,'final-verification'),{secrets});
    t.finalSha256=hash(current);t.finalSnapshot='final.html';t.gatesPassed=final.checks.filter(c=>c.passed).length;t.gatesTotal=final.checks.length;const accepted=final.passed&&t.stages.at(-1)?.passed;t.status=accepted?'passed':'failed';t.reason=accepted?null:'Final full acceptance or final visual review failed';
   }
   await saveJson(trialPath,t);await persist();console.log(JSON.stringify({event:'trial-finished',batch:config.id,trial,status:t.status,modelRepairs:t.modelRepairs}));
  }
  summary.status='complete';summary.successes=summary.trials.filter(t=>t.status==='passed').length;summary.attempted=summary.trials.length;await persist();return summary;
 }catch(e){summary.status='blocked';summary.reason=e.message;summary.attempted=summary.trials.length;await persist();throw e;}
}

if(process.argv[1]?.endsWith('run-reproduction.mjs')) throw Error('Use reproduce.mjs; default dry-run, explicit --live required');
