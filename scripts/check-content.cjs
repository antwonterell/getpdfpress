'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..');
const app=fs.readFileSync(path.join(root,'public/app.js'),'utf8');
const helpers=app.split('// BEGIN result-reporting:')[1].split('\n').slice(1).join('\n').split('// END result-reporting')[0];
const context={};vm.createContext(context);vm.runInContext(helpers+'\nthis.api={fmt,resultChange,targetWarning};',context);
const {fmt,resultChange,targetWarning}=context.api;
for(const kb of [200,500]){
 const bytes=kb*1024;
 assert.equal(targetWarning('compress',String(kb),bytes),'');
 for(const n of [bytes+1,bytes*1.05]) assert.match(targetWarning('compress',String(kb),n),/Target missed/);
 assert.equal(targetWarning('merge',String(kb),bytes+1),'');
}
assert.match(targetWarning('merge-compress','',512001),/Target missed/);
assert.equal(resultChange(1000,1000),'Unchanged');assert.equal(resultChange(1000,1100),'10.0% larger');assert.equal(resultChange(1000,900),'10.0% smaller');
assert.equal(fmt(204801),'204,801 bytes (200.00 KiB)');
assert.ok(app.includes('dl.href=blobUrl; dl.download=name;'),'Download must remain available on target miss');
assert.ok(app.includes('targetWarning(mode,target,blob.size)'),'Use actual received bytes, not a success header');
assert.ok(!app.includes('Math.max(0,Math.round((1-blob.size/totalIn)*100))'),'Do not hide growth');
const files=fs.readdirSync(path.join(root,'public')).filter(n=>n.endsWith('.html')).map(n=>'public/'+n).concat(fs.readdirSync(path.join(root,'public/learn')).filter(n=>n.endsWith('.html')).map(n=>'public/learn/'+n));
let schemas=0;
for(const file of files){const html=fs.readFileSync(path.join(root,file),'utf8');for(const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)){JSON.parse(m[1]);schemas++;}
 assert.ok(!/pagead2\.googlesyndication\.com\/pagead\/js|adsbygoogle\.push/.test(html),'Ads must remain inactive: '+file);
}
for(const name of ['index','compress-pdf-200kb','compress-pdf-500kb','merge-pdf-to-500kb','pdf-to-word','word-to-pdf']){
 const html=fs.readFileSync(path.join(root,'public/'+name+'.html'),'utf8');
 const uploader=html.split('<div class="uploader">')[1].split('<p class="file-name')[0];
 assert.ok(uploader.includes('ConvertAPI')&&uploader.includes('/privacy'),'Point-of-upload disclosure missing: '+name);
}
for(const n of [200,500]){const h=fs.readFileSync(path.join(root,`public/compress-pdf-${n}kb.html`),'utf8');assert.ok(h.includes((n*1024).toLocaleString('en-US')+' bytes'),'Target byte units');}
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
assert.ok(server.includes('originalSize <= 10 * 1024 * 1024'),'Benchmark provider-bypass guard changed: reassess evidence before running live tests');
console.log(`PASS: strict exact/+1/+5% byte boundaries, growth reporting, download retention, ${schemas} JSON-LD blocks, disclosures, target units and inactive ads.`);

const evidence=JSON.parse(fs.readFileSync(path.join(root,'public/test-results/results.json'),'utf8'));
for(const n of [200,500]){
 const h=fs.readFileSync(path.join(root,'public/compress-pdf-'+n+'kb.html'),'utf8');
 for(const record of evidence.results.filter(x=>x.targetKB===n)) assert.ok(h.includes(record.outputBytes.toLocaleString('en-US')),'Published result differs from evidence');
 assert.ok(h.includes('selectable text lost')&&h.includes('page dimensions'),'Rasterization tradeoffs must stay explicit');
 assert.ok(h.includes('/test-results/README.md'),'Reproduction notes must remain linked');
}
const rejectedClaims=['A bloated scan compresses 90%','Typical result: 5% to 30%','Most applicant systems are built around the larger cap','Text is essentially a bystander','assume 2MB for web forms','assume 2MB for a web form','Built for searchers','Why people search pdf merge'];
for(const f of files){const h=fs.readFileSync(path.join(root,f),'utf8');for(const claim of rejectedClaims)assert.ok(!h.includes(claim),'Unsupported claim returned: '+f+' '+claim);}
console.log('PASS: displayed measured results, rasterization warnings, reproduction links and unsupported-claim regression guard.');

const privacy=fs.readFileSync(path.join(root,'public/privacy.html'),'utf8');
assert.ok(privacy.includes('roughly an hour')&&privacy.includes('not a guaranteed deletion deadline')&&privacy.includes('Provider processing is subject to its own retention practices'));
assert.ok(server.includes('const maxAge = 30 * 60 * 1000')&&server.includes('}, 30 * 60 * 1000)'),'Cleanup policy must be revisited when schedule changes');
for(const f of files){const h=fs.readFileSync(path.join(root,f),'utf8');assert.ok(!h.includes('plain statements when a target cannot be reached readably')&&!h.includes('no daily task limit'),'Shared claims must reflect actual behavior');}
