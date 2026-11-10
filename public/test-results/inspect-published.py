"""Offline verification of the three published PDFs. No network or server needed."""
from pathlib import Path
import hashlib,json
from pypdf import PdfReader
root=Path(__file__).resolve().parent
data=json.loads((root/'results.json').read_text(encoding='utf-8'))
for filename,fixture,target in [('born-digital.pdf','born-digital',200),('image-heavy-200kb.pdf','image-heavy',200),('image-heavy-500kb.pdf','image-heavy',500)]:
    record=next(r for r in data['results'] if r['fixture']==fixture and r['targetKB']==target)
    raw=(root/filename).read_bytes()
    pdf=PdfReader(root/filename)
    assert len(raw)==record['outputBytes'],filename+' byte count mismatch'
    assert hashlib.sha256(raw).hexdigest()==record['outputSHA256'],filename+' SHA-256 mismatch'
    assert len(pdf.pages)==record['outputPages'],filename+' page count mismatch'
    assert sum(len(p.extract_text() or '') for p in pdf.pages)==record['outputTextCharacters'],filename+' text count mismatch'
    assert sum(len(p.images) for p in pdf.pages)==record['outputImages'],filename+' image count mismatch'
    assert [float(x) for x in pdf.pages[0].mediabox[2:]]==record['outputPageSizePoints'],filename+' dimensions mismatch'
    print(filename, 'PASS',len(raw),'bytes',len(pdf.pages),'pages')
print('Three published PDFs checked. No compression rerun or 101-page output verification.')
