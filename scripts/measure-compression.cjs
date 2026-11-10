/* Run the real application locally with the paid provider disabled.
 * Optional --live-large sends ONLY >10MiB synthetic fixtures to production,
 * whose current source skips ConvertAPI above that threshold. Read README first.
 */
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {spawn}=require('child_process');
const {PDFDocument}=require('pdf-lib');
const root=path.resolve(__dirname,'..'), dir=path.join(root,'output/compression-benchmark');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const local=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:'3179',CONVERTAPI_SECRET:''},stdio:['ignore',fs.openSync(path.join(dir,'server.log'),'w'),fs.openSync(path.join(dir,'server-error.log'),'w')]});
  const results=[];
  if(process.argv.includes('--live-large') && !process.argv.includes('--verified-live-free-routes')) { local.kill(); throw Error('Live mode requires explicit --verified-live-free-routes after checking the deployed source and permission.'); }
  try {
    let ready=false;
    for(let i=0;i<40;i++){try {const h=await(await fetch('http://127.0.0.1:3179/api/health')).json();assert.equal(h.features.office,'not configured');ready=true;break;}catch(e){await sleep(250)}}
    assert(ready,'local server must start with provider disabled');
    // Normalize the small fixture using the application's own optimization first.
    async function post(base,name,target,bytes){
      const form=new FormData();form.append('file',new Blob([bytes],{type:'application/pdf'}),name+'.pdf');form.append('targetSize',String(target));
      const r=await fetch(base+'/api/compress',{method:'POST',body:form,signal:AbortSignal.timeout(120000)});
      assert.equal(r.status,200); assert.match(r.headers.get('content-type'),/application\/pdf/);
      const out=Buffer.from(await r.arrayBuffer());assert.equal(out.subarray(0,5).toString(),'%PDF-');
      assert.equal(out.length,Number(r.headers.get('content-length')));return {r,out};
    }
    const input=fs.readFileSync(path.join(dir,'born-digital.pdf'));
    const normalized=await post('http://127.0.0.1:3179','born-digital',500,input);
    fs.writeFileSync(path.join(dir,'born-digital.pdf'),normalized.out);
    const names=(process.argv.includes('--live-large') || process.argv.includes('--all-local'))?['born-digital','image-heavy','long-document']:['born-digital'];
    for(const name of names)for(const target of [200,500]){
      const bytes=fs.readFileSync(path.join(dir,name+'.pdf'));
      const live=process.argv.includes('--live-large');
      if(live && name!=='born-digital') assert(bytes.length>10*1024*1024,'large live fixtures MUST skip paid ConvertAPI branch');
      if(live && name==='born-digital') assert(bytes.length<=target*1024,'small fixture must stay on basicCompress');
      const base=live?'https://getpdfpress.com':'http://127.0.0.1:3179';
      const {r,out}=await post(base,name,target,bytes);
      const filename=`${name}-${target}kb.pdf`;fs.writeFileSync(path.join(dir,filename),out);
      const a=await PDFDocument.load(bytes),b=await PDFDocument.load(out);
      assert.equal(b.getPageCount(),a.getPageCount(),'all pages must survive');
      assert(out.length<=bytes.length,'must not grow');
      const record={fixture:name,targetKB:target,targetBytes:target*1024,inputBytes:bytes.length,outputBytes:out.length,inputPages:a.getPageCount(),outputPages:b.getPageCount(),method:r.headers.get('x-compression-method'),reportedMiss:r.headers.get('x-target-miss')==='true',strictTargetMet:out.length<=target*1024,identicalBytes:bytes.equals(out),source:live?'production; intended free route under inspected source, active backend commit not independently verified':'local production server; ConvertAPI disabled',filename};
      if(record.method==='convertapi')throw Error('Unexpected paid provider branch');
      if(record.identicalBytes)assert.equal(record.method,'original');
      results.push(record);fs.writeFileSync(path.join(dir,'results.json'),JSON.stringify({date:'2026-11-10',node:process.version,results},null,2));
      console.log(JSON.stringify(record)); await sleep(1000);
    }
  }finally{local.kill();}
})().catch(e=>{console.error(e);process.exitCode=1});



