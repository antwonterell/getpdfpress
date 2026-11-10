"""Inspect every page of measured PDFs and render representative pages at 96 dpi."""
from pathlib import Path
import hashlib,json,subprocess,shutil
from pypdf import PdfReader
ROOT=Path(__file__).resolve().parents[1]; D=ROOT/'output'/'compression-benchmark'
poppler=shutil.which('pdftoppm')
if not poppler: raise RuntimeError('pdftoppm must be on PATH')
data=json.loads((D/'results.json').read_text())
for row in data['results']:
    src=D/(row['fixture']+'.pdf'); dst=D/row['filename']
    a=PdfReader(src); b=PdfReader(dst)
    ta=[p.extract_text() or '' for p in a.pages];tb=[p.extract_text() or '' for p in b.pages]
    row.update(inputSHA256=hashlib.sha256(src.read_bytes()).hexdigest(),outputSHA256=hashlib.sha256(dst.read_bytes()).hexdigest(),inputTextCharacters=sum(map(len,ta)),outputTextCharacters=sum(map(len,tb)),textEqual=ta==tb,outputImages=sum(len(p.images) for p in b.pages),inputPageSizePoints=[float(x) for x in a.pages[0].mediabox[2:]],outputPageSizePoints=[float(x) for x in b.pages[0].mediabox[2:]])
    assert len(a.pages)==len(b.pages)
    # All pages checked for count/text/images. Representative pages visual only.
    subprocess.run([poppler,'-f','1','-l','1','-singlefile','-r','96','-png',str(dst),str(D/dst.stem)],check=True)
for name in ['born-digital','image-heavy','long-document']:
    subprocess.run([poppler,'-f','1','-l','1','-singlefile','-r','96','-png',str(D/(name+'.pdf')),str(D/(name+'-input'))],check=True)
(D/'results.json').write_text(json.dumps(data,indent=2))
print(json.dumps(data,indent=2))
