import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {verifyReproduction} from './verify-reproduction.mjs';
import {inspectHtml} from './verify-experiment-app.mjs';
import {saveJson,hash} from './experiment-preflight.mjs';
const out=resolve(process.argv[2]);await mkdir(out,{recursive:true});const source=await readFile('index.html','utf8');
const fixtures=[
 {id:'wrong-formula',round:4,target:/independent dense physical matrix/,edit:s=>s.replace('sinc * sinc * Math.cos(beta) * Math.cos(beta)','Math.cos(beta) * Math.cos(beta)')},
 {id:'wrong-mapping',round:1,target:/actual Canvas curve|pattern pixel profile/,edit:s=>s.replace('pixelOffset / (4 * params.screenDistance * params.zoom)','pixelOffset / (8 * params.screenDistance * params.zoom)')},
 {id:'missing-sync',round:3,target:/same-x indicator/,edit:s=>s.replace(/(ctx\.putImageData\(image, 0, 0\);)\s*if \(Number\.isFinite\(state\.hoverX\)\) \{[\s\S]*?\n        \}/,'$1')},
 {id:'broken-focus',round:6,target:/focus closed loop/,edit:s=>s.replaceAll('elements.modalCloseButton.focus();','/* intentionally missing focus */')},
];
const report={purpose:'synthetic-negative-fixtures-only-never-model-input',sourceSha256:hash(source),results:[]};
for(const fixture of fixtures){const dir=join(out,fixture.id);await mkdir(dir,{recursive:true});const html=fixture.edit(source);await writeFile(join(dir,'fixture.html'),html);const r=await verifyReproduction(join(dir,'fixture.html'),join(dir,'evidence'),{round:fixture.round,full:false});const failures=r.checks.filter(c=>!c.passed&&fixture.target.test(c.name));report.results.push({id:fixture.id,rejected:failures.length>0,targetFailures:failures,sha256:hash(html)});}
const fake=source.replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?>/i,m=>'<!--'+m+'-->');report.results.push({id:'fake-csp',rejected:inspectHtml(fake).length>0,issues:inspectHtml(fake)});
report.passed=report.results.every(r=>r.rejected);await saveJson(join(out,'negative-gates.json'),report);console.log(JSON.stringify(report));if(!report.passed)process.exitCode=1;
