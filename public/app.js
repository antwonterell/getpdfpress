
(function(){
  // Mobile hamburger nav (runs on every page that has the shared header)
  const navBar=document.querySelector('.site-header .nav'), navLinks=navBar&&navBar.querySelector('.nav-links');
  if(navBar&&navLinks){
    const t=document.createElement('button');
    t.className='nav-toggle'; t.type='button'; t.setAttribute('aria-label','Open menu'); t.setAttribute('aria-expanded','false'); t.textContent='☰';
    navBar.insertBefore(t,navLinks);
    t.addEventListener('click',()=>{const open=navLinks.classList.toggle('open'); t.setAttribute('aria-expanded',open); t.setAttribute('aria-label',open?'Close menu':'Open menu');});
  }

  const $ = (s, c=document)=>c.querySelector(s);
  const $$ = (s, c=document)=>Array.from(c.querySelectorAll(s));
  const fmt = b => !b ? '0 KB' : b < 1024*1024 ? Math.round(b/1024)+' KB' : (b/1024/1024).toFixed(1)+' MB';
  const esc = s => s.replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
  const endpointMap={compress:'/api/compress',merge:'/api/merge',split:'/api/split','jpg-to-pdf':'/api/images-to-pdf','pdf-to-jpg':'/api/pdf-to-images-zip','word-to-pdf':'/api/word-to-pdf','pdf-to-word':'/api/pdf-to-word'};

  $$('.pdf-tool').forEach(tool=>{
    const mode=tool.dataset.tool||'compress', target=tool.dataset.target||'', multi=['merge','jpg-to-pdf'].includes(mode);
    const input=$('.file-input',tool), drop=$('.uploader',tool), btn=$('.run-btn',tool), status=$('.status',tool), result=$('.result',tool);
    const original=$('.original-size',tool), final=$('.final-size',tool), saved=$('.saved-size',tool), dl=$('.download-link',tool), fileName=$('.file-name',tool);
    let files=[], blobUrl=null;
    fileName.classList.add('file-list');

    function setStatus(msg,type=''){status.textContent=msg; status.className='status show '+type;}

    function ready(){ return mode==='merge' ? files.length>=2 : files.length>=1; }

    function render(){
      if(!files.length){
        fileName.textContent='No file selected';
      }else{
        fileName.innerHTML=files.map((f,i)=>`<span class="file-chip"><span class="chip-name">${esc(f.name)}</span><span class="chip-size">${fmt(f.size)}</span><button type="button" class="chip-x" data-i="${i}" aria-label="Remove ${esc(f.name)}">✕</button></span>`).join('')
          + (multi ? '<span class="file-chip add-more">+ Add more</span>' : '');
      }
      btn.disabled=!ready();
      if(files.length){
        const total=files.reduce((n,f)=>n+f.size,0);
        if(mode==='merge'&&files.length<2) setStatus('Add at least one more PDF to merge.');
        else setStatus(`${files.length} file${files.length>1?'s':''} ready (${fmt(total)} total). Review the list above, then press the button. Processing is best-effort and exact targets are not guaranteed.`);
      }else{
        status.className='status';
      }
    }

    function addFiles(list){
      const incoming=Array.from(list||[]);
      if(!incoming.length) return;
      if(multi){
        for(const f of incoming){
          if(!files.some(x=>x.name===f.name&&x.size===f.size)) files.push(f);
        }
      }else{
        files=[incoming[0]];
      }
      render();
    }

    fileName.addEventListener('click',e=>{
      const x=e.target.closest('.chip-x');
      if(x){ files.splice(Number(x.dataset.i),1); render(); return; }
      if(e.target.closest('.add-more')){ input.click(); }
    });

    ['dragenter','dragover'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('drag')}));
    ['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('drag')}));
    drop.addEventListener('drop',e=>addFiles(e.dataTransfer.files));
    drop.addEventListener('click',()=>input.click());
    input.addEventListener('change',()=>{addFiles(input.files); input.value='';});

    let progressEl=null;
    function showProgress(){
      if(progressEl) return;
      progressEl=document.createElement('div');
      progressEl.className='progressbar';
      progressEl.setAttribute('role','progressbar');
      progressEl.setAttribute('aria-label','Processing');
      progressEl.innerHTML='<div class="bar"></div>';
      status.insertAdjacentElement('afterend',progressEl);
    }
    function hideProgress(){ if(progressEl){progressEl.remove(); progressEl=null;} }

    const btnLabel=btn.textContent;
    btn.addEventListener('click',async()=>{
      if(!ready()) return;
      if(blobUrl) URL.revokeObjectURL(blobUrl);
      result.classList.remove('show'); btn.disabled=true; btn.textContent='Working…';
      setStatus('Working on it now. Larger scanned PDFs can take a moment - no need to click again.');
      showProgress();
      try{
        const fd=new FormData();
        files.forEach(f=>fd.append(multi?'files':'file',f));
        if(target) fd.append('targetSize',target);
        const res=await fetch(endpointMap[mode],{method:'POST',body:fd});
        if(!res.ok){let j={}; try{j=await res.json()}catch{} throw new Error(j.message||j.error||`Server returned ${res.status}`)}
        const blob=await res.blob(); blobUrl=URL.createObjectURL(blob);
        const cd=res.headers.get('Content-Disposition')||''; const m=cd.match(/filename="?([^";]+)"?/);
        const name=m?m[1]:(mode==='split'||mode==='pdf-to-jpg'?'getpdfpress-output.zip':'getpdfpress-output.pdf');
        dl.href=blobUrl; dl.download=name;
        const totalIn=files.reduce((n,f)=>n+f.size,0);
        original.textContent=fmt(totalIn); final.textContent=fmt(blob.size);
        const pct=Math.max(0,Math.round((1-blob.size/totalIn)*100)); saved.textContent=pct+'%';
        result.classList.add('show');
        const warning=res.headers.get('X-Warning-Message');
        setStatus(warning||'Done. Download your processed file below.','ok');
        window.getPDFpressDownloadComplete=function(){ if(window.gtag) gtag('event','download_complete',{tool:mode}); };
      }catch(err){setStatus(err.message||'Something went wrong. Please try a smaller file or a different tool.','err')}
      finally{hideProgress(); btn.textContent=btnLabel; btn.disabled=!ready();}
    });

    render();
  });
})();
