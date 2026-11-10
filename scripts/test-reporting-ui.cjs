'use strict';
// UI reporting regression with synthetic HTTP responses, NOT compression evidence.
// Install Playwright separately or set PLAYWRIGHT_MODULE to an existing installation.
const fs=require('fs'),path=require('path'),http=require('http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.join(__dirname,'..','public');
const server=http.createServer((req,res)=>{let url=new URL(req.url,'http://localhost');let file=url.pathname==='/'?'index.html':url.pathname.slice(1);if(!path.extname(file))file+='.html';const target=path.resolve(root,file);if(!target.startsWith(root+path.sep)){res.writeHead(403).end();return;}try{const b=fs.readFileSync(target);res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(b);}catch{res.writeHead(404).end();}});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
 try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 let outputBytes=204800;
 await page.route('**/api/compress',route=>route.fulfill({status:200,headers:{'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="test-output.pdf"','X-Compression-Method':'pdf-lib'},body:Buffer.alloc(outputBytes,32)}));
 for(const target of [200,500]){
 await page.goto(`http://127.0.0.1:${port}/compress-pdf-${target}kb`);
 assert.equal(await page.locator('.run-btn').isDisabled(),true);
 await page.locator('.file-input').setInputFiles({name:'synthetic.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.7\nUI fixture only')});
 assert.equal(await page.locator('.run-btn').isEnabled(),true);
 // A canceled picker must preserve the prior selected file.
 await page.locator('.file-input').setInputFiles([]);
 assert.equal(await page.locator('.run-btn').isEnabled(),true);
 for(const offset of [0,1,target*1024*.05]){
 outputBytes=target*1024+offset;await page.locator('.run-btn').click();await page.waitForFunction(()=>document.querySelector('.result').classList.contains('show')&&!document.querySelector('.run-btn').disabled);
 const status=await page.locator('.status').innerText();assert.equal(status.includes('Target missed'),offset>0);
 assert.ok((await page.locator('.final-size').innerText()).includes(outputBytes.toLocaleString('en-US')+' bytes'));
 assert.match(await page.locator('.saved-size').innerText(),/larger/);
 const downloadPromise=page.waitForEvent('download');await page.locator('.download-link').click();const download=await downloadPromise;assert.equal(download.suggestedFilename(),'test-output.pdf');
 const stream=await download.createReadStream();let size=0;for await(const chunk of stream)size+=chunk.length;assert.equal(size,outputBytes);
 }
 await page.locator('.chip-x').click();assert.equal(await page.locator('.run-btn').isDisabled(),true);assert.equal(await page.locator('.result').isVisible(),false);
 }
 for(const width of [390,1280]){await page.setViewportSize({width,height:900});for(const slug of ['compress-pdf-200kb','compress-pdf-500kb','pdf-to-word','word-to-pdf','merge-pdf-to-500kb']){await page.goto(`http://127.0.0.1:${port}/${slug}`);assert.ok((await page.locator('.uploader').innerText()).includes('ConvertAPI'));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'horizontal overflow '+slug);if(process.env.QA_SCREENSHOT_DIR){fs.mkdirSync(process.env.QA_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.QA_SCREENSHOT_DIR,slug+'-'+width+'.png'),fullPage:true});}}}
 await page.goto('http://127.0.0.1:'+port+'/compress-pdf-200kb');let pickerOpened=false;page.on('filechooser',()=>{pickerOpened=true;});await page.locator('.uploader a[href="/privacy"]').click();assert.ok(page.url().endsWith('/privacy'));assert.equal(pickerOpened,false,'Privacy link must not trigger file picker');
 assert.deepEqual(errors,[]);console.log('PASS: isolated browser UI regression, exact/+1/+5% targets, actual download byte counts, growth label, repeat processing, canceled selection, removal, mobile/desktop disclosure and overflow checks. API responses here were synthetic, not measured compression.');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
