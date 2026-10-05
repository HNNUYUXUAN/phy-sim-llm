import {readFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium,runtimeInfo} from './fixed-playwright.mjs';
import {observeCanvas,settled,blindPeak} from './verify-reproduction.mjs';
import {saveJson,hash} from './experiment-preflight.mjs';
import {defaults,oracle} from './experiment-oracle.mjs';
export async function auditDeployment(app,out,{expectedVersion='0.9.1'}={}){
 await mkdir(out,{recursive:true});const source=await readFile(app),r={purpose:'Final deployment compliance measurements of already-frozen requirements',appSha256:hash(source),runtime:runtimeInfo,checks:[],measurements:[]};const check=(name,passed,detail)=>r.checks.push({name,passed:!!passed,detail});
 const browser=await chromium.launch({headless:true});
 try{for(const dpr of [1,2,3])for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
  const label=`${viewport.width}/DPR${dpr}`,context=await browser.newContext({viewport,deviceScaleFactor:dpr,offline:true}),page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});await context.route('**/*',route=>/^https?:/.test(route.request().url())?route.abort():route.continue());await page.addInitScript(observeCanvas);
  try{await page.goto(pathToFileURL(resolve(app)).href+'?theme=light&palette=grayscale');await page.evaluate(()=>window.PhySim.ready);await settled(page);
   check(label+': delivered API version',await page.evaluate(v=>window.PhySim.version===v,expectedVersion),expectedVersion);
   for(const [key,value] of Object.entries({wavelength:620,slitSeparation:7600,slitWidth:2000,screenDistance:80,zoom:4})){
    await page.locator('#reset-button').click();await settled(page);check(label+': reset '+key,JSON.stringify(await page.evaluate(()=>window.PhySim.getParams()))===JSON.stringify(defaults));
    const actual=await page.evaluate(({key,value})=>{const input=document.getElementById(key);input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));return{params:window.PhySim.getParams(),label:document.getElementById(key+'-output').textContent};},{key,value});check(label+': slider '+key,actual.params[key]===value&&!!actual.label,actual);
   }
   const p={...defaults,zoom:3};const peak=await blindPeak(page,p);await settled(page);const canvas=page.locator('#intensityCanvas'),box=await canvas.boundingBox();
   const drawing=await page.evaluate(()=>window.__paperDrawingEvidence().intensityCanvas??[]);const path=drawing.filter(p=>p.length>30).sort((a,b)=>b.length-a.length)[0];
   const span=p.wavelength/p.slitSeparation,scale=4*p.screenDistance*p.zoom,target=box.width/2+scale*peak.eta;
   const near=path?.filter(q=>q.x>=box.width/2+scale*.5*span&&q.x<=box.width/2+scale*1.5*span).sort((a,b)=>a.y-b.y)[0];const error=near?Math.abs(near.x-target):Infinity;
   check(label+': drawn first peak position within 2 CSS pixels',error<=2,{drawnX:near?.x,expectedX:target,cssPixelError:error,physicalEta:peak.eta});
   await canvas.hover({position:{x:target,y:box.height*.5}});await settled(page);const text=await page.locator('#intensity-tooltip').innerText();const value=Number(text.match(/(?:η|eta)\s*[:=]?\s*(-?[\d.]+)/i)?.[1]);
   check(label+': hover eta and intensity rounding',Number.isFinite(value)&&Math.abs(value-peak.eta)<=.00055,{text,etaError:Math.abs(value-peak.eta),expectedEta:peak.eta,expectedIntensity:oracle(peak.eta,p)});
   r.measurements.push({viewport,dpr,peak,targetCssX:target,actualCssX:near?.x,pixelError:error,hoverText:text});check(label+': health',!errors.length,errors);
  }catch(e){check(label+': completed',false,e.message);}finally{await context.close();}
 }}finally{await browser.close();}
 r.passed=r.checks.every(c=>c.passed);await saveJson(join(out,'deployment-audit.json'),r);return r;
}
if(process.argv[1]?.endsWith('audit-deployment.mjs')){const r=await auditDeployment(resolve(process.argv[2]),resolve(process.argv[3]),{expectedVersion:process.argv[4]??'0.9.1'});console.log(JSON.stringify({passed:r.passed,checks:r.checks.length,failed:r.checks.filter(c=>!c.passed)}));if(!r.passed)process.exitCode=1;}
