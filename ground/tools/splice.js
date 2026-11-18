// splice.js — 用起止标记整块替换 app.js 里的一段（比逐行 edit 稳）
// 用法: node tools/splice.js <src> <blockFile> <startMarker> <endMarker...>
//   把从 startMarker 开始到 endMarker（不含）之间的内容整块换成 blockFile 的内容
const fs = require('fs');
const [srcPath, blockPath, startMarker, ...endMarkers] = process.argv.slice(2);
let src = fs.readFileSync(srcPath, 'utf8');
let block = fs.readFileSync(blockPath, 'utf8');
if (!block.endsWith('\n')) block += '\n';
const si = src.indexOf(startMarker);
if (si < 0) { console.error('START NOT FOUND:', startMarker); process.exit(2); }
let ei = -1, em = '';
for (const m of endMarkers) { const k = src.indexOf(m, si + startMarker.length); if (k >= 0 && (ei < 0 || k < ei)) { ei = k; em = m; } }
if (ei < 0) { console.error('END NOT FOUND:', endMarkers.join(' | ')); process.exit(3); }
const before = src.slice(0, si), after = src.slice(ei);
fs.writeFileSync(srcPath + '.bak', src);
fs.writeFileSync(srcPath, before + block + after);
console.log(`spliced ${srcPath}: [${si},${ei}) ${ei - si} -> ${block.length} bytes (end marker: ${JSON.stringify(em)})`);
