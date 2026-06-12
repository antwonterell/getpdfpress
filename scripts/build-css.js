const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', 'src', 'site.css');
const out = path.join(__dirname, '..', 'public', 'output.css');
const css = fs.readFileSync(src, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ')
  .replace(/\s*([{}:;,>])\s*/g, '$1')
  .trim();
fs.writeFileSync(out, css);
console.log(`Built ${path.relative(process.cwd(), out)} (${css.length} bytes)`);
