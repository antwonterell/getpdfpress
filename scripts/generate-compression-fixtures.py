"""Deterministic, nonsensitive fixtures. Requires reportlab and Pillow. No network."""
from pathlib import Path
from io import BytesIO
import random
from PIL import Image, ImageDraw
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'output'/'compression-benchmark'
OUT.mkdir(parents=True,exist_ok=True)
# Random pixels represent a difficult high-detail background, not a real scan.
# A fixed seed and fixed PDF timestamps make fixtures reproducible.
rng=random.Random(20261110)
w,h=2400,2000
im=Image.frombytes('RGB',(w,h),rng.randbytes(w*h*3))
d=ImageDraw.Draw(im)
d.rectangle((40,40,2360,420),fill='white')
# PDF text is drawn separately so rasterization can be tested for loss of selection.
buf=BytesIO(); im.save(buf,format='PNG'); image=ImageReader(buf)
for name,count,art in [('born-digital',1,False),('image-heavy',2,True),('long-document',101,True)]:
    c=canvas.Canvas(str(OUT/(name+'.pdf')),pagesize=(612,792),invariant=1,pageCompression=1)
    c.setTitle('Synthetic compression benchmark'); c.setAuthor('')
    for page in range(1,count+1):
        if art: c.drawImage(image,0,0,width=612,height=792)
        c.setFillColorRGB(0,0,0)
        c.setFont('Helvetica-Bold',18); c.drawString(24,757,'SYNTHETIC PDF - NO PERSONAL DATA')
        for j,size in enumerate([12,10,8,6]):
            c.setFont('Helvetica',size)
            c.drawString(24,727-j*21,f'{size} point sample: ABC 0123456789, invoice total 123.45, page {page}.')
        c.showPage()
    c.save()
    print(name,(OUT/(name+'.pdf')).stat().st_size,count)
