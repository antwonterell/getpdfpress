const fs=require('fs'),path=require('path'),assert=require('assert/strict'),crypto=require('crypto');
const {PDFDocument}=require('pdf-lib');
(async()=>{
 const p=path.resolve(__dirname,'../public/test-results'), data=JSON.parse(fs.readFileSync(path.join(p,'results.json')));
 assert.equal(data.results.length,6);
 for(const r of data.results){
  assert.equal(r.targetBytes,r.targetKB*1024);assert.equal(r.inputPages,r.outputPages);assert(r.outputBytes<=r.inputBytes);
  assert.equal(r.strictTargetMet,r.outputBytes<=r.targetBytes);
  if(r.fixture==='image-heavy'){assert.equal(r.outputTextCharacters,0);assert.equal(r.outputImages,2);assert.equal(r.method,'pdf-to-images');}
  if(r.fixture==='long-document'){assert.equal(r.outputPages,101);assert(r.reportedMiss);assert(!r.strictTargetMet);assert(r.textEqual);}
  if(r.fixture==='born-digital'){assert(r.identicalBytes);assert(r.textEqual);}
  const f=path.join(p,r.filename);
  if(fs.existsSync(f)){
   const b=fs.readFileSync(f);assert.equal(b.length,r.outputBytes);assert.equal(crypto.createHash('sha256').update(b).digest('hex'),r.outputSHA256);
   assert.equal((await PDFDocument.load(b)).getPageCount(),r.outputPages);
  }
 }
 const small=fs.readFileSync(path.join(p,'born-digital.pdf'));assert.equal(crypto.createHash('sha256').update(small).digest('hex'),data.results[0].inputSHA256);
 for(const n of ['generate-compression-fixtures.py','measure-compression.cjs','inspect-compression.py'])assert(fs.readFileSync(path.join(p,n)).equals(fs.readFileSync(path.resolve(__dirname,n))),n+' public copy differs');
 console.log('Compression evidence: six records, limits, page counts, published PDF hashes, and script copies verified. No network calls.');
})().catch(e=>{console.error(e);process.exitCode=1});
