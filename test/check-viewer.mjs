/* =====================================================================
 * 页面自检（纯 Node，不需要浏览器）：md-viewer.html 的结构与语法完整性
 *
 * 校验点：
 *   · <style> / <script> 标签配对
 *   · 内联 CSS 的花括号、圆括号平衡，关键过渡声明还在
 *   · 两段 JSON 数据块可解析
 *   · 内联脚本（md-core / md-app）语法通过
 *   · 关键 JS 钩子（动效、首屏防闪）没被改掉
 *
 * 用途：改动 md-viewer.html 后先跑它，几秒内就能发现低级错误。
 * 用法：node test/check-viewer.mjs      （失败退出码 1）
 * ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'md-viewer.html');
const html = fs.readFileSync(FILE, 'utf8');

let bad = 0;
const ok = (m) => console.log('  ok   ' + m);
const fail = (m) => { bad++; console.log('  FAIL ' + m); };

console.log('[1] 结构');
const styleOpen = (html.match(/<style>/g) || []).length;
const styleClose = (html.match(/<\/style>/g) || []).length;
styleOpen === styleClose ? ok(`<style> ${styleOpen} 对`) : fail(`<style> ${styleOpen}/${styleClose}`);
const scriptOpen = (html.match(/<script[ >]/g) || []).length;
const scriptClose = (html.match(/<\/script>/g) || []).length;
scriptOpen === scriptClose ? ok(`<script> ${scriptOpen} 对`) : fail(`<script> ${scriptOpen}/${scriptClose}`);

console.log('[2] CSS');
const css = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'));
const cssNoComment = css.replace(/\/\*[\s\S]*?\*\//g, '');
for (const [a, b, name] of [['{', '}', '花括号'], ['(', ')', '圆括号']]) {
  const n = (cssNoComment.split(a).length - 1) - (cssNoComment.split(b).length - 1);
  n === 0 ? ok(`${name}平衡`) : fail(`${name}差 ${n}`);
}
for (const s of ['--ease-out', 'body.left-hidden .sidebar', 'body.right-hidden .toc',
                 'visibility 0s linear var(--dur)', '.toc>*{width:calc(var(--right-w) - 1px)}',
                 'prefers-reduced-motion', 'html.preload', '.article.pop{animation:riseIn', '.toc-list{']) {
  css.includes(s) ? ok('含 ' + s) : fail('缺 ' + s);
}

console.log('[3] 内联脚本语法');
const re = /<script id="([^"]+)"([^>]*)>([\s\S]*?)<\/script>/g;
let m, n = 0;
while ((m = re.exec(html))) {
  const [, id, attrs, body] = m;
  if (/type="application\/json"/.test(attrs)) {
    try { JSON.parse(body); ok(`${id}（JSON 可解析）`); }
    catch (e) { fail(`${id} JSON 解析失败：${e.message}`); }
    continue;
  }
  try { new vm.Script(body, { filename: id + '.js' }); ok(`${id} 语法通过`); n++; }
  catch (e) { fail(`${id} 语法错误：${e.message}`); }
}
if (!n) fail('没有找到任何内联脚本');

console.log('[4] 关键钩子');
for (const s of ['function popArticle()', 'function enableMotion()', 'popArticle();', 'enableMotion();',
                 "classList.remove('preload')", "fetch('config.json'", "fetch('docs-index.json'"]) {
  html.includes(s) ? ok('含 ' + s) : fail('缺 ' + s);
}
if (/\bdochelper\b/.test(html)) fail('还残留 dochelper 字样（应已改为工程内相对路径）');

console.log(bad ? `\n✗ ${bad} 项失败` : '\n✓ 全部通过');
process.exit(bad ? 1 : 0);
