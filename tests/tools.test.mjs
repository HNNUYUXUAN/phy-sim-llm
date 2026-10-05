import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadPaperModelProfiles,callPaperModel,validateBailianBaseUrl} from '../scripts/paper-models.mjs';
import {Journal} from '../scripts/experiment-journal.mjs';
import {decodeHtml} from '../scripts/experiment-runner.mjs';
import {inspectHtml} from '../scripts/verify-experiment-app.mjs';
import {session} from '../scripts/reproduction-session.mjs';
const profiles=await loadPaperModelProfiles({route:'bailian',preferLocalEnv:true,env:{DASHSCOPE_API_KEY:'fixture-credential-local-only'},authEpoch:'mock-epoch'});
const messages=[{role:'user',content:'Return a tiny complete HTML document.'}];
const body=(content='<!doctype html><html></html>',finish='stop')=>({id:'mock-request',model:profiles.coder.modelId,usage:{prompt_tokens:12,completion_tokens:10},choices:[{finish_reason:finish,message:{content}}]});
const response=value=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
test('official HTTPS endpoint validation',()=>{
 for(const url of ['http://dashscope.aliyuncs.com/compatible-mode/v1','https://example.com/compatible-mode/v1','https://x:secret@dashscope.aliyuncs.com/compatible-mode/v1','https://dashscope.aliyuncs.com/compatible-mode/v1?key=1'])assert.throws(()=>validateBailianBaseUrl(url));
 assert.equal(validateBailianBaseUrl('https://llm-abc.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'),'https://llm-abc.cn-beijing.maas.aliyuncs.com/compatible-mode/v1');
});
test('complete HTML parser and real head CSP gate',()=>{
 assert.throws(()=>decodeHtml('<html>truncated'));
 assert.match(decodeHtml('```html\n<!doctype html><html></html>\n```'),/^<!doctype/);
 assert.ok(inspectHtml('<!doctype html><html><head></head><body><!-- Content-Security-Policy --></body></html>').length);
});
for(const [label,value,known] of [['truncated',body('partial','length'),true],['empty',body('','stop'),true],['missing-completion',body('partial',null),false]]){
 test(label+' is retained and not applied',async()=>{
  await assert.rejects(()=>callPaperModel('coder',{profiles,messages,maxCompletionTokens:100,fetch:async()=>response(value)}),e=>known?!!e.evidence:!!e.partialEvidence);
 });
}
test('unknown transport has no retry',async()=>{
 let calls=0;await assert.rejects(()=>callPaperModel('coder',{profiles,messages,fetch:async()=>{calls++;throw Error('fixture disconnect');}}),/unknown/);assert.equal(calls,1);
});
test('cache resume, immutable requests, atomic ledger and redaction',async()=>{
 const root=await mkdtemp(join(tmpdir(),'physim-journal-'));let calls=0;
 const transport=async(role,options)=>{calls++;return callPaperModel(role,{...options,fetch:async()=>response(body('fixture-credential-local-only'))});};
 const j=await new Journal(root,profiles,{transport}).init();const options={messages,maxCompletionTokens:100};
 const a=await j.call('mock-one','coder',options);assert.equal(a.content,'[REDACTED]');
 const resumed=await new Journal(root,profiles,{transport}).init();await resumed.call('mock-one','coder',options);assert.equal(calls,1);
 await assert.rejects(()=>resumed.call('mock-one','coder',{...options,messages:[{role:'user',content:'changed'}]}),/Frozen request changed/);
 assert.equal(JSON.parse(await readFile(join(root,'budget.json'))).calls[0].status,'complete');
 assert.ok(!(await readFile(join(root,'calls/mock-one.json'),'utf8')).includes('fixture-credential-local-only'));
});
test('unknown outcome blocks continuation and keeps reserve',async()=>{
 const root=await mkdtemp(join(tmpdir(),'physim-unknown-'));let calls=0;
 const j=await new Journal(root,profiles,{transport:async()=>{calls++;throw Error('fixture unknown');}}).init();
 await assert.rejects(()=>j.call('mock-unknown','coder',{messages,maxCompletionTokens:100}));
 await assert.rejects(()=>j.call('mock-next','coder',{messages,maxCompletionTokens:100}),/unresolved/);
 assert.equal(calls,1);const b=JSON.parse(await readFile(join(root,'budget.json')));assert.ok(b.spentCny>0);assert.equal(b.calls[0].status,'unknown');
});
test('budget gate precedes transport',async()=>{
 const root=await mkdtemp(join(tmpdir(),'physim-budget-'));let calls=0;
 const j=await new Journal(root,profiles,{transport:async()=>{calls++;}}).init();
 await assert.rejects(()=>j.call('mock-large','coder',{messages,maxCompletionTokens:10000000}),/Budget gate/);assert.equal(calls,0);
});
test('single executor lock and unchanged identity resume',async()=>{
 const root=await mkdtemp(join(tmpdir(),'physim-lock-'));
 const privateFile=join(process.cwd(),'.env.reproduction-'+root.split(/[\\/]/).at(-1)+'.json');
 const first=await session(root);
 try{await assert.rejects(()=>session(root),/Another executor/);}finally{await first.release();}
 const second=await session(root);assert.equal(second.authEpoch,first.authEpoch);await second.release();await unlink(privateFile);
});
