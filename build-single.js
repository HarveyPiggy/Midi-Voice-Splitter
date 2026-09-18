// 把 index.html + midi-core.js + synth.js 内联打包成一个可双击运行的 HTML
const fs = require('fs');
const path = require('path');
const dir = __dirname;

let html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const core = fs.readFileSync(path.join(dir, 'midi-core.js'), 'utf8');
const synth = fs.readFileSync(path.join(dir, 'synth.js'), 'utf8');

function inline(tag) {
  const file = tag.match(/src="([^"]+)"/)[1];
  const code = fs.readFileSync(path.join(dir, file), 'utf8');
  if (/<\/script/i.test(code)) throw new Error(file + ' 含 </script，需转义');
  return '<script>\n/* ===== ' + file + ' ===== */\n' + code + '\n</script>';
}

const before = html;
html = html.replace(/<script src="[^"]+"><\/script>/g, inline);
if (html === before) throw new Error('没有替换任何 script 标签');

const out = path.join(dir, 'dist', 'MIDI声部分离器.html');
fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
fs.writeFileSync(out, html, 'utf8');
console.log('OK ->', out, '| bytes:', Buffer.byteLength(html, 'utf8'));
console.log('剩余外链 script:', (html.match(/<script src=/g) || []).length);
