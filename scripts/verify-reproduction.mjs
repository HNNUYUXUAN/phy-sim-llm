import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {chromium,runtimeInfo} from './fixed-playwright.mjs';
import {hash,saveJson} from './experiment-preflight.mjs';
import {verifyApp,inspectHtml} from './verify-experiment-app.mjs';
import {defaults,limits,oracle,numericalPeak,wavelengths,separations,referenceEta} from './experiment-oracle.mjs';

// Independent browser-side drawing observer. Candidate code is never patched.
export function observeCanvas(){
 const paths=new WeakMap(), strokes=new Map();
 const proto=CanvasRenderingContext2D.prototype;
 for(const name of ['beginPath','moveTo','lineTo','stroke','clearRect','fillRect']){
  const original=proto[name];
  proto[name]=function(...args){
   if(name==='beginPath')paths.set(this,[]);
   if(name==='moveTo'||name==='lineTo'){
    const t=this.getTransform(), r=this.canvas.getBoundingClientRect(), sx=this.canvas.width/r.width,sy=this.canvas.height/r.height;
    const points=paths.get(this)??[];if(points.length<12000)points.push({x:(t.a*args[0]+t.c*args[1]+t.e)/sx,y:(t.b*args[0]+t.d*args[1]+t.f)/sy});paths.set(this,points);
   }
   if(name==='clearRect'||name==='fillRect'){
    const t=this.getTransform(),x=t.a*args[0]+t.c*args[1]+t.e,y=t.b*args[0]+t.d*args[1]+t.f,w=t.a*args[2],h=t.d*args[3];
    if(x<=0&&y<=0&&x+w>=this.canvas.width-.5&&y+h>=this.canvas.height-.5)strokes.set(this.canvas.id,[]);
   }
   if(name==='stroke'){const list=strokes.get(this.canvas.id)??[];list.push(paths.get(this)??[]);if(list.length>30)list.shift();strokes.set(this.canvas.id,list);}
   return original.apply(this,args);
  };
 }
 Object.defineProperty(window,'__paperDrawingEvidence',{value:()=>JSON.parse(JSON.stringify(Object.fromEntries(strokes))),writable:false,configurable:false});
}
export async function settled(page){await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));}
export async function blindPeak(page,params,order=1){
 return page.evaluate(({p,m})=>{
  window.PhySim.setParams(p);const s=p.wavelength/p.slitSeparation;
  const lo=(m-.5)*s,hi=(m+.5)*s;let best={eta:lo,intensity:-1},step=(hi-lo)/4096;
  for(let i=0;i<=4096;i++){const eta=lo+i*step,value=window.PhySim.intensityAtEta(eta);if(value>best.intensity)best={eta,intensity:value};}
  let a=Math.max(lo,best.eta-step),b=Math.min(hi,best.eta+step);
  for(let i=0;i<70;i++){let x=a+(b-a)/3,y=b-(b-a)/3;if(window.PhySim.intensityAtEta(x)<window.PhySim.intensityAtEta(y))a=x;else b=y;}
  const eta=(a+b)/2;return {eta,intensity:window.PhySim.intensityAtEta(eta),searchedInterval:[lo,hi]};
 },{p:params,m:order});
}
function expectedMarkers(p){
 const out={wavelength:[],slitSeparation:[]};
 for(let twice=1;twice<=80;twice++){const order=twice/2,kind=twice%2?'dark':'bright';
  for(const key of Object.keys(out)){const value=key==='wavelength'?p.slitSeparation*referenceEta/order:order*p.wavelength/referenceEta;if(value>=limits[key][0]&&value<=limits[key][1])out[key].push({kind,order,value});}}
 for(const key of Object.keys(out))out[key].sort((a,b)=>a.value-b.value);return out;
}
export async function verifyReproduction(appPath,output,{round=7,full=round===7,secrets=[]}={}){
 await mkdir(output,{recursive:true});
 const source=await readFile(appPath,'utf8');
 const report={schemaVersion:2,appSha256:hash(source),round,runtime:runtimeInfo,browserFallback:'Browser plugin not available',checks:[],screenshots:[],observations:[],untestedBrowsers:['Firefox','WebKit']};
 const check=(name,passed,detail=null)=>report.checks.push({name,passed:!!passed,detail});
 const safety=inspectHtml(source,secrets);check('strict offline safety',!safety.length,safety);
 if(safety.length){report.passed=false;await saveJson(join(output,'verification.json'),report);return report;}
 const legacy=await verifyApp(appPath,join(output,'core'),{round,secrets,full});
 report.core=legacy;report.checks.push(...legacy.checks.map(c=>({...c,name:'core: '+c.name})));
 const server=createServer((req,res)=>{if(!['/','/index.html'].includes(new URL(req.url,'http://local').pathname)){res.writeHead(404);res.end();return;}res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(source);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({headless:true});
 try{
  const scenarios=full?[1,2,3].flatMap(dpr=>['desktop','mobile'].flatMap(size=>['http','file','file-offline'].map(mode=>({dpr,size,mode})))):[{dpr:1,size:'desktop',mode:'file-offline'}];
  for(const scenario of scenarios){
   const {dpr,size,mode}=scenario, label=`${size}/${mode}/DPR${dpr}`,viewport=size==='desktop'?{width:1440,height:900}:{width:390,height:844};
   const context=await browser.newContext({viewport,deviceScaleFactor:dpr,colorScheme:'light'}),page=await context.newPage();
   const errors=[],requests=[];page.on('console',m=>{if(m.type()==='error')errors.push(m.text().slice(0,300));});page.on('pageerror',e=>errors.push(e.message.slice(0,300)));
   await context.route('**/*',r=>{const u=r.request().url();if(/^https?:/i.test(u)&&!u.startsWith(base+'/')){requests.push(u.split('?')[0]);return r.abort();}return r.continue();});
   await page.addInitScript(observeCanvas);if(mode==='file-offline')await context.setOffline(true);
   try{
    const url=mode==='http'?new URL(base+'/'):new URL(pathToFileURL(resolve(appPath)).href);url.searchParams.set('theme','light');url.searchParams.set('palette','grayscale');
    await page.goto(url.href,{waitUntil:'load',timeout:15000});
    if(round>=1){await page.waitForFunction(()=>!!window.PhySim?.ready,null,{timeout:6000});await page.evaluate(()=>window.PhySim.ready);await settled(page);}
    check(label+': page identity',/干涉|双缝/.test(await page.title())&&(await page.locator('body').innerText()).length>50);
    check(label+': no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth));
    if(round>=1){
     await page.evaluate(p=>window.PhySim.setParams(p),{...defaults,zoom:3});await settled(page);
     if(round>=7){const m=await page.evaluate(()=>['interferenceCanvas','intensityCanvas'].map(id=>{const c=document.getElementById(id),r=c.getBoundingClientRect();return{left:r.left,width:r.width,ratio:c.width/r.width};}));check(label+': both Canvas backing and horizontal alignment',m.every(v=>Math.abs(v.ratio-dpr)<.02)&&Math.abs(m[0].left-m[1].left)<1&&Math.abs(m[0].width-m[1].width)<1,m);}
     const drawing=await page.evaluate(()=>({paths:window.__paperDrawingEvidence().intensityCanvas??[],width:document.querySelector('#intensityCanvas').getBoundingClientRect().width}));
     const curve=drawing.paths.filter(p=>p.length>30).toReversed().sort((a,b)=>b.length-a.length)[0];
     let detail={points:curve?.length??0,maxIntensityError:null};let curveOK=false;
     if(curve){const ymin=Math.min(...curve.map(p=>p.y)),ymax=Math.max(...curve.map(p=>p.y));let error=0;for(let i=0;i<curve.length;i+=Math.max(1,Math.floor(curve.length/160))){const q=curve[i],eta=(q.x-drawing.width/2)/(4*50*3);error=Math.max(error,Math.abs((ymax-q.y)/(ymax-ymin)-oracle(eta,{...defaults,zoom:3})));}detail.maxIntensityError=error;curveOK=ymax-ymin>40&&error<=.025;}
     check(label+': actual Canvas curve matches independent physics (2.5% raster bound)',curveOK,detail);
     const pattern=await page.evaluate(()=>{const c=document.querySelector('#interferenceCanvas'),r=c.getBoundingClientRect(),ctx=c.getContext('2d'),data=ctx.getImageData(0,Math.floor(c.height*.5),c.width,1).data;return {width:r.width,ratio:c.width/r.width,columns:Array.from({length:c.width},(_,x)=>(data[x*4]+data[x*4+1]+data[x*4+2])/3)};});
     const sorted=pattern.columns.toSorted((a,b)=>a-b),low=sorted[Math.floor(sorted.length*.02)],high=sorted[Math.floor(sorted.length*.98)];let bestError=Infinity,bestGamma=null;
     for(let gamma=.35;gamma<=1.55;gamma+=.01){let sum=0,n=0;for(let x=0;x<pattern.columns.length;x+=Math.max(1,Math.floor(pattern.columns.length/160))){const eta=(x/pattern.ratio-pattern.width/2)/600;sum+=Math.abs((pattern.columns[x]-low)/(high-low)-Math.pow(oracle(eta,defaults),gamma));n++;}if(sum/n<bestError){bestError=sum/n;bestGamma=gamma;}}
     check(label+': pattern pixel profile matches physics under monotone gamma',high-low>40&&bestError<.08,{meanIntensityError:bestError,gamma:bestGamma});
    }
    if(round>=3){
     const canvas=page.locator('#intensityCanvas'),box=await canvas.boundingBox(),x=box.width/2+40;
     const before=await page.evaluate(x=>Object.fromEntries(['interferenceCanvas','intensityCanvas'].map(id=>{const c=document.getElementById(id),ratio=c.width/c.getBoundingClientRect().width,start=Math.max(0,Math.floor((x-4)*ratio)),width=Math.min(c.width-start,Math.ceil(8*ratio));return[id,{start,width,data:Array.from(c.getContext('2d').getImageData(start,0,width,c.height).data)}];})),x);
     await canvas.hover({position:{x,y:box.height*.5}});await settled(page);
     const hover=await page.evaluate(({prior,x})=>{
      const out={text:document.querySelector('#intensity-tooltip').textContent,columns:{}};
      for(const id of ['interferenceCanvas','intensityCanvas']){const c=document.getElementById(id),{start,width,data:old}=prior[id],data=c.getContext('2d').getImageData(start,0,width,c.height).data,counts=[];
       for(let px=0;px<width;px++){let count=0;for(let y=0;y<c.height;y++){const j=(y*width+px)*4;if(Math.abs(data[j]-old[j])+Math.abs(data[j+1]-old[j+1])+Math.abs(data[j+2]-old[j+2])>12)count++;}counts.push(count);}
       out.columns[id]={changedRows:Math.max(...counts),height:c.height};}
      return out;
     },{prior:before,x});
     const pct=Number(hover.text.match(/([\d.]+)\s*%/)?.[1]);const eta=(x-box.width/2)/600;
     check(label+': hover percentage numerical accuracy',Number.isFinite(pct)&&Math.abs(pct-100*oracle(eta,defaults))<=.15,{text:hover.text,expectedPct:100*oracle(eta,defaults)});
     check(label+': same-x indicator actually appears on both canvases',Object.values(hover.columns).every(v=>v.changedRows>v.height*.2),hover.columns);
     await page.mouse.move(1,1);await settled(page);check(label+': leave hides tooltip',!await page.locator('#intensity-tooltip').isVisible());
     await canvas.focus();await page.keyboard.press('Home');const home=await page.locator('#intensity-tooltip').innerText();await page.keyboard.press('ArrowRight');const right=await page.locator('#intensity-tooltip').innerText();await page.keyboard.press('ArrowLeft');const left=await page.locator('#intensity-tooltip').innerText();
     check(label+': Home/arrows operate curve',!!home&&right!==home&&left!==right,{home,right,left});
    }
    if(round>=5){
     const p={...defaults,slitSeparation:6000,wavelength:660};await page.evaluate(p=>window.PhySim.setParams(p),p);await settled(page);const actual=await page.evaluate(()=>window.PhySim.getCriticalMarkers()),expected=expectedMarkers(p);
     const equal=Object.keys(expected).every(key=>actual[key]?.length===expected[key].length&&expected[key].every(e=>actual[key].some(a=>a.kind===e.kind&&a.order===e.order&&Math.abs(a.value-e.value)<1e-8)));
     check(label+': complete wavelength/separation marker sets',equal,{actual,expected});
     const style=await page.evaluate(()=>Object.fromEntries(['wavelength','slitSeparation'].map(key=>{const root=document.getElementById(key+'-markers'),bright=root.querySelector('.bright,[data-kind="bright"]'),dark=root.querySelector('.dark,[data-kind="dark"]');const b=bright&&getComputedStyle(bright),d=dark&&getComputedStyle(dark);return[key,{count:root.children.length,solid:b?.backgroundColor,hollow:d?.backgroundColor,border:d?.borderTopWidth}];})));
     check(label+': markers visibly distinguish bright/dark',Object.keys(expected).every(k=>style[k].count===expected[k].length&&style[k].solid&&style[k].hollow&&style[k].solid!==style[k].hollow),style);
    }
    if(round>=6){
     await page.locator('#principle-button').click();const dialog=page.getByRole('dialog');await dialog.waitFor({state:'visible',timeout:3000});await settled(page);
     const inside=()=>page.evaluate(()=>{const d=document.querySelector('[role="dialog"]');return d?.contains(document.activeElement);});check(label+': initial dialog focus',await inside());
     let trapped=true;for(const key of ['Tab','Tab','Shift+Tab','Shift+Tab']){await page.keyboard.press(key);trapped&&=await inside();}check(label+': Tab/Shift+Tab focus closed loop',trapped);
     await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});check(label+': Escape focus return',await page.evaluate(()=>document.activeElement.id==='principle-button'));
     await page.locator('#principle-button').click();await dialog.waitFor({state:'visible'});await settled(page);await page.locator('#modal-close-button').click();await settled(page);check(label+': close button closes dialog',!await dialog.isVisible());
     await page.locator('#principle-button').click();await dialog.waitFor({state:'visible'});await settled(page);await page.locator('#principle-modal').click({position:{x:3,y:3}});await settled(page);check(label+': backdrop closes dialog',!await dialog.isVisible());
    }
    if(round>=7){
     const states=[];for(let i=0;i<4;i++){states.push(await page.evaluate(()=>({theme:document.documentElement.dataset.theme,background:getComputedStyle(document.body).backgroundColor})));await page.locator('#theme-button').click();await settled(page);}
     check(label+': both themes actually render',states.some(s=>s.theme==='dark')&&states.some(s=>s.theme==='light')&&new Set(states.map(s=>s.background)).size>1,states);
     const pixels=()=>page.evaluate(()=>{const c=document.getElementById('interferenceCanvas');return Array.from(c.getContext('2d').getImageData(0,Math.floor(c.height*.5),c.width,1).data);});
     const p0=await page.locator('html').getAttribute('data-palette'),colors0=await pixels();await page.locator('#palette-button').click();await settled(page);const p1=await page.locator('html').getAttribute('data-palette'),colors1=await pixels();check(label+': palette really changes Canvas colors',p0!==p1&&colors0.some((v,i)=>v!==colors1[i]));
     await context.setOffline(true);await page.evaluate(()=>{window.PhySim.setParams({wavelength:690});document.getElementById('slitWidth').value='3000';document.getElementById('slitWidth').dispatchEvent(new Event('input',{bubbles:true}));});await settled(page);
     check(label+': offline controls and API',await page.evaluate(()=>window.PhySim.getParams().wavelength===690&&window.PhySim.getParams().slitWidth<=window.PhySim.getParams().slitSeparation));
    }
    if(full&&scenario.dpr===1&&size==='desktop'&&mode==='http'){
     for(const [scan,values,key]of [['wavelength',wavelengths,'wavelength'],['separation',separations,'slitSeparation']]){
      for(const value of values){const p={...defaults,[key]:value},ideal=p.wavelength/p.slitSeparation,missing=Math.abs(oracle(ideal,p))<1e-10,observed=missing?null:await blindPeak(page,p),expected=missing?null:numericalPeak(p);
       report.observations.push({scan,value,params:p,idealEta:ideal,missingIdealOrder:missing,observedPeak:observed,fullFormulaPrediction:expected,residualEta:observed?observed.eta-ideal:null});if(observed)check(`${scan}/${value}: blind actual peak`,Math.abs(observed.eta-expected.eta)<ideal*1e-6&&Math.abs(observed.intensity-expected.intensity)<1e-10,{observed,expected});}
     }
     const wave=report.observations.filter(o=>o.scan==='wavelength');check('wavelength increases real fringe spacing',wave.every((o,i)=>!i||o.observedPeak.eta>wave[i-1].observedPeak.eta));
     const separation=report.observations.filter(o=>o.scan==='separation');check('ideal spacing times d is constant',separation.every(o=>Math.abs(o.idealEta*o.value-defaults.wavelength)<1e-10));
     const peak=await blindPeak(page,defaults,2);check('observed second peak below center',peak.intensity>0&&peak.intensity<1,peak);
     const widths=await page.evaluate(p=>{window.PhySim.setParams(p);const s=p.wavelength/p.slitSeparation,mins=[];for(const order of [-.5,.5,1.5,2.5]){let a=(order-.2)*s,b=(order+.2)*s;for(let i=0;i<80;i++){const x=a+(b-a)/3,y=b-(b-a)/3;if(window.PhySim.intensityAtEta(x)>window.PhySim.intensityAtEta(y))a=x;else b=y;}mins.push((a+b)/2);}return {central:mins[1]-mins[0],second:mins[3]-mins[2],boundaries:mins};},defaults);
     check('measured adjacent-dark widths agree',Math.abs(widths.central-widths.second)<1e-8&&widths.central>0,widths);
     const scaleEvidence=[];
     for(const [screenDistance,zoom] of [[10,1],[50,3],[100,5]]){
      const p={...defaults,screenDistance,zoom};await page.evaluate(p=>window.PhySim.setParams(p),p);await settled(page);
      const v=await page.evaluate(()=>({intensity:window.PhySim.intensityAtEta(.071),paths:window.__paperDrawingEvidence().intensityCanvas??[],width:document.getElementById('intensityCanvas').getBoundingClientRect().width}));
      const path=v.paths.filter(p=>p.length>30).toReversed().sort((a,b)=>b.length-a.length)[0];let err=Infinity;
      if(path){const min=Math.min(...path.map(q=>q.y)),max=Math.max(...path.map(q=>q.y));err=0;for(let i=0;i<path.length;i+=Math.max(1,Math.floor(path.length/160))){const q=path[i];err=Math.max(err,Math.abs((max-q.y)/(max-min)-oracle((q.x-v.width/2)/(4*screenDistance*zoom),p)));}}
      scaleEvidence.push({screenDistance,zoom,intensity:v.intensity,maxRasterError:err,secondPeakCssOffset:4*screenDistance*zoom*peak.eta});
     }
     check('Dsim/Z preserve physics and actually rescale drawing',scaleEvidence.every(v=>Math.abs(v.intensity-oracle(.071,defaults))<1e-10&&v.maxRasterError<.03),scaleEvidence);
     report.highOrder={peak,widths,scaleEvidence};
    }
    check(label+': console health',!errors.length,errors);check(label+': no external requests',!requests.length,requests);
    const file=`${size}-${mode}-dpr${dpr}.png`;const metadata=await page.evaluate(()=>({params:window.PhySim?.getParams?.()??null,theme:document.documentElement.dataset.theme,palette:document.documentElement.dataset.palette}));
    await page.screenshot({path:join(output,file),fullPage:true});report.screenshots.push({file,viewport,dpr,mode,...metadata,programSha256:report.appSha256,sha256:hash(await readFile(join(output,file)))});
   }catch(e){check(label+': execution',false,e.message.slice(0,500));}
   finally{await context.close();}
  }
 }finally{await browser.close();await new Promise(r=>server.close(r));}
 report.passed=report.checks.every(c=>c.passed);await saveJson(join(output,'verification.json'),report);
 if(report.observations.length)await writeFile(join(output,'teaching-observations.csv'),['scan,value,ideal_eta,observed_eta,peak_intensity,residual_eta,missing_order',...report.observations.map(o=>[o.scan,o.value,o.idealEta,o.observedPeak?.eta??'',o.observedPeak?.intensity??'',o.residualEta??'',o.missingIdealOrder].join(','))].join('\n')+'\n');
 return report;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const r=await verifyReproduction(resolve(process.argv[2]),resolve(process.argv[3]));console.log(JSON.stringify({passed:r.passed,checks:r.checks.length,failed:r.checks.filter(c=>!c.passed)}));if(!r.passed)process.exitCode=1;}
