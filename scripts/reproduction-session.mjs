import {readFile,writeFile,mkdir,open,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {loadPaperModelProfiles,publicPaperModelProfile} from './paper-models.mjs';
import {Journal} from './experiment-journal.mjs';
import {saveJson,positions} from './experiment-preflight.mjs';
import {decodeHtml} from './experiment-runner.mjs';
import {inspectHtml} from './verify-experiment-app.mjs';
import {chromium} from './fixed-playwright.mjs';
export const primaryModels={visual:'qwen3.7-plus-2026-05-26',coder:'qwen3.8-max-0902'};
export async function maybeJson(p){try{return JSON.parse(await readFile(p,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
export async function session(root){
 await mkdir(root,{recursive:true});
 const lockPath=join(root,'executor.lock');
 let lock;
 try{lock=await open(lockPath,'wx');}catch(e){if(e.code!=='EEXIST')throw e;const owner=await maybeJson(lockPath);let alive=true;try{process.kill(owner.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}if(alive)throw Error('Another executor owns this run: PID '+owner.pid);await unlink(lockPath);lock=await open(lockPath,'wx');}
 await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));await lock.close();
 const release=()=>unlink(lockPath);
 try{
  let profiles=await loadPaperModelProfiles({route:'bailian',preferLocalEnv:true,modelIds:primaryModels});
  const digest=createHash('sha256').update(profiles.coder.credential+'\0'+profiles.coder.endpoint).digest('hex');
  const privatePath=resolve('.env.reproduction-'+root.split(/[\\/]/).at(-1)+'.json');
  const existing=await maybeJson(join(root,'session.json'));
  let authEpoch;
  if(existing){const privateState=await maybeJson(privatePath);if(privateState?.digest!==digest)throw Error('Credentials changed: create a new authEpoch/run; old calls must not be reused');authEpoch=existing.authEpoch;}
  else{authEpoch=randomUUID();await writeFile(privatePath,JSON.stringify({digest,authEpoch}));await saveJson(join(root,'session.json'),{authEpoch,createdAt:new Date().toISOString(),endpoint:profiles.coder.endpoint,models:primaryModels,credentialSource:'explicit-local-env-first',budgetCny:200});}
  profiles=Object.fromEntries(Object.entries(profiles).map(([k,p])=>[k,{...p,authEpoch}]));
  const journal=await new Journal(root,profiles).init();await journal.persist();
  return {profiles,journal,authEpoch,prefix:'r200-'+authEpoch,release};
 }catch(e){await release();throw e;}
}
export async function qualify(root,s){
 const dir=join(root,'qualification',s.authEpoch+(s.qualificationLabel?'-'+s.qualificationLabel:''));await mkdir(dir,{recursive:true});
 const report={status:'running',authEpoch:s.authEpoch,models:Object.fromEntries(Object.entries(s.profiles).map(([k,v])=>[k,publicPaperModelProfile(v)])),probes:[],pricingSource:'https://help.aliyun.com/zh/model-studio/model-pricing'};
 const call=async(id,role,text,images)=>s.journal.call(s.prefix+'-qual-'+id,role,{messages:[{role:'user',content:text}],imagePaths:images,maxCompletionTokens:8192,enableThinking:false,stream:true,timeoutMs:240000});
 try{
  const code=await call('code','coder','Only return JavaScript: function normalize(x){...} returns finite x clamped to [380,750]; invalid values default to 550. No dependencies.');
  const js=code.content.replace(/^```(?:javascript|js)?\s*/i,'').replace(/\s*```\s*$/,'').trim();
  const html='<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:"></head><body><script>'+js+'</script></body></html>';
  if(inspectHtml(html,[]).length)throw Error('Unsafe normalization probe, not executed');
  const browser=await chromium.launch({headless:true});let actual;
  try{const context=await browser.newContext({offline:true});await context.route('**/*',r=>r.abort());const page=await context.newPage();await page.setContent(html);actual=await page.evaluate(()=>[normalize(100),normalize(800),normalize(NaN),normalize(600)]);}finally{await browser.close();}
  report.probes.push({kind:'code-normalization',passed:JSON.stringify(actual)==='[380,750,550,600]',actual,requestId:code.requestId});
  for(let i=0;i<2;i++){
   const r=await call('layout-'+(i+1),'visual','Observe this diagram. Return only JSON {"controls":"position","pattern":"position","curve":"position"}; choose from left,right,left-top,left-bottom,right-top,right-bottom based on labelled boxes.',[join(root,'preflight','inputs','wireframe-'+(i+1)+'.png')]);
   const actual=JSON.parse(r.content.match(/\{[\s\S]*\}/)?.[0]);report.probes.push({kind:'image-layout',layout:i+1,actual,passed:Object.keys(positions[i]).every(k=>actual[k]===positions[i][k]),requestId:r.requestId});
  }
  for(const role of ['visual','coder']){
   const r=await call(role+'-offline',role,'Generate a complete tiny offline HTML document from <!doctype html> to </html>. In its real head include meta http-equiv="Content-Security-Policy" content="default-src \'none\'; connect-src \'none\'; frame-src \'none\'; object-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:". Include range input id="wavelength", canvas id="intensityCanvas" and inline script setting window.probeReady=true and drawing a line. No network or dependencies. Return full HTML only.',role==='visual'?[join(root,'preflight','inputs','wireframe-1.png')]:undefined);
   const html=decodeHtml(r.content);await writeFile(join(dir,role+'-offline.html'),html);const issues=inspectHtml(html,[]);let executed=false;
   if(!issues.length){const browser=await chromium.launch({headless:true});try{const context=await browser.newContext({offline:true});await context.route('**/*',r=>r.abort());const page=await context.newPage();await page.setContent(html);executed=await page.evaluate(()=>window.probeReady===true&&!!document.querySelector('#intensityCanvas')&&!!document.querySelector('#wavelength'));}finally{await browser.close();}}
   report.probes.push({kind:'offline-document',role,passed:issues.length===0&&executed,issues,executed,requestId:r.requestId});
  }
  report.status=report.probes.every(p=>p.passed)?'passed':'failed';
 }catch(e){report.status='blocked';report.error=e.message;}
 await saveJson(join(dir,'report.json'),report);return report;
}
if(process.argv[1]?.endsWith('reproduction-session.mjs')){throw Error('Use reproduce.mjs; paid requests require explicit --live --budget-cny 200');}
