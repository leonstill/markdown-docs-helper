/* =====================================================================
 * 页面自检（纯 Node，不需要浏览器）：
 *   · page.template.html —— 两个页面唯一的布局来源（改页面只改它）
 *   · md-viewer.html     —— 离线单文件产物（引擎必须整段内联在页面里）
 *   · index.html         —— 实时版产物（引擎必须是本地外链，见 check-realtime.mjs）
 *
 * 校验点：
 *   · 模板里 <script>/<style> 标签配对、占位块齐全、外链的 CSS/JS 都引到了
 *   · CSS（assets/viewer.css）花括号、圆括号平衡，关键过渡声明还在
 *   · 模板里的 JSON 占位块可解析（空串占位）
 *   · 脚本语法通过：assets/ 下的 mindmap-core / md-core / md-app + 离线产物里内联的引擎块
 *   · 关键 JS 钩子（动效、首屏防闪、思维导图、全屏）没被改掉
 *
 * 用途：改动 page.template.html 或 assets/ 后先跑它，几秒内就能发现低级错误。
 * 用法：node test/check-viewer.mjs      （失败退出码 1）
 * 前置：先跑一次 node build-docs.mjs（产物必须已生成）
 * ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(ROOT, 'page.template.html');
const VIEWER = path.join(ROOT, 'md-viewer.html');
const ASSETS = path.join(ROOT, 'assets');

let bad = 0;
const ok = (m) => console.log('  ok   ' + m);
const fail = (m) => { bad++; console.log('  FAIL ' + m); };

if (!fs.existsSync(TEMPLATE)) { console.log('FAIL 找不到 page.template.html（页面布局的唯一来源）'); process.exit(1); }
if (!fs.existsSync(VIEWER)) { console.log('FAIL 找不到 md-viewer.html，先跑 node build-docs.mjs'); process.exit(1); }

const tpl = fs.readFileSync(TEMPLATE, 'utf8');
const html = fs.readFileSync(VIEWER, 'utf8');

/* 页面外链的资源（自研代码）：CSS + 四段脚本 */
const ASSET_FILES = ['viewer.css', 'mindmap-core.js', 'mermaid-core.js', 'md-core.js', 'md-app.js'];
const assetPath = (f) => path.join(ASSETS, f);
const assetText = (f) => fs.readFileSync(assetPath(f), 'utf8');
/* 关键钩子可能落在模板里，也可能落在 assets/ 的脚本里，合并起来找 */
const allCode = tpl + '\n' + html + '\n' + ASSET_FILES.map((f) => (fs.existsSync(assetPath(f)) ? assetText(f) : '')).join('\n');

console.log('[1] 模板结构（page.template.html）');
const styleOpen = (tpl.match(/<style>/g) || []).length;
const styleClose = (tpl.match(/<\/style>/g) || []).length;
styleOpen === styleClose ? ok(`<style> ${styleOpen} 对`) : fail(`<style> ${styleOpen}/${styleClose}`);
const tplScriptOpen = (tpl.match(/<script[ >]/g) || []).length;
const tplScriptClose = (tpl.match(/<\/script>/g) || []).length;
tplScriptOpen === tplScriptClose ? ok(`<script> ${tplScriptOpen} 对`) : fail(`<script> ${tplScriptOpen}/${tplScriptClose}`);

/* 模板里的占位块必须是空块：数据由构建写入，引擎由构建填内联或外链 */
const PLACEHOLDERS = ['viewer-config', 'docs-snapshot', 'build-info', 'help-docs', 'vendor-d3', 'vendor-markmap-lib', 'vendor-markmap-view', 'vendor-mermaid'];
for (const id of PLACEHOLDERS) {
  const m = new RegExp(`<script id="${id}"([^>]*)>([\\s\\S]*?)</script>`).exec(tpl);
  if (!m) { fail(`模板缺少占位块 <script id="${id}">`); continue; }
  m[2].trim() === '' ? ok(`模板占位块 ${id} 是空的（由构建填充）`) : fail(`模板占位块 ${id} 里不该有内容`);
}
/* 实时版的外链写法必须与模板占位块 id 一一对应，构建才知道怎么换 */
for (const id of PLACEHOLDERS.filter((x) => x.startsWith('vendor-'))) {
  tpl.includes(`<script id="${id}">`) ? ok(`模板里 ${id} 占位写法规范`) : fail(`模板里 ${id} 占位写法不规范`);
}

for (const f of ASSET_FILES) {
  fs.existsSync(assetPath(f)) && assetText(f).trim() ? ok(`assets/${f} 存在且非空`)
    : fail(`assets/${f} 缺失或是空文件`);
}
tpl.includes('<link rel="stylesheet" href="assets/viewer.css">')
  ? ok('模板外链 assets/viewer.css') : fail('模板没有外链 assets/viewer.css');
for (const id of ['mindmap-core', 'mermaid-core', 'md-core', 'md-app']) {
  tpl.includes(`<script id="${id}" src="assets/${id}.js"></script>`)
    ? ok(`模板外链 assets/${id}.js`) : fail(`模板没有外链 assets/${id}.js`);
}

console.log('[2] 离线产物结构（md-viewer.html）');
html.length > tpl.length ? ok(`产物比模板大（模板 ${(tpl.length / 1024).toFixed(1)} KB → 产物 ${(html.length / 1024).toFixed(0)} KB，说明数据与引擎都填进去了）`)
  : fail(`产物没有比模板大，占位块可能没填上（模板 ${tpl.length} / 产物 ${html.length}）`);
for (const id of ['viewer-config', 'docs-snapshot', 'build-info', 'help-docs']) {
  const m = new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)</script>`).exec(html);
  if (!m) { fail(`产物缺少 <script id="${id}">`); continue; }
  try { JSON.parse(m[1]); ok(`${id}（JSON 可解析）`); }
  catch (e) { fail(`${id} JSON 解析失败：${e.message}`); }
}
/* 帮助正文来自 help/*.md：构建要把它整份塞进页面，且「正则表达式」必须单独成页 */
const helpMatch = /<script id="help-docs" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
if (helpMatch) {
  try {
    const pages = JSON.parse(helpMatch[1]);
    const isList = Array.isArray(pages);
    const goodPages = isList && pages.length > 0 &&
      pages.every((p) => p && typeof p.title === 'string' && typeof p.md === 'string' && p.md.trim());
    goodPages
      ? ok(`help-docs 里有 ${pages.length} 页帮助（${pages.map((p) => p.title).join(' / ')}）`)
      : fail('help-docs 不是非空的 { title, md } 数组');
    isList && pages.some((p) => p && p.title === '正则表达式')
      ? ok('帮助里「正则表达式」是独立一页')
      : fail('帮助里没有单独的「正则表达式」页');
  } catch (e) { fail('help-docs JSON 解析失败：' + e.message); }
}
/* 版本块的内容要能对上根目录的 VERSION：pre-commit 刷的就是它 */
const biMatch = /<script id="build-info" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
const versionFile = path.join(ROOT, 'VERSION');
if (biMatch && fs.existsSync(versionFile)) {
  const bi = JSON.parse(biMatch[1]);
  const raw = fs.readFileSync(versionFile, 'utf8').trim();
  `${bi.version}+${bi.commit}` === raw
    ? ok(`build-info 与根目录 VERSION 一致（${raw}）`)
    : fail(`build-info ${bi.version}+${bi.commit} 与 VERSION ${raw} 不一致（产物没跟着重建？）`);
}
/* 引擎块：内联（大块源码）或按需留空（data-disabled / data-unused），两者都必须无裸 </script */
for (const id of PLACEHOLDERS.filter((x) => x.startsWith('vendor-'))) {
  const m = new RegExp(`<script id="${id}"([^>]*)>([\\s\\S]*?)</script>`).exec(html);
  if (!m) { fail(`产物缺少引擎块 ${id}`); continue; }
  if (/data-(disabled|unused)="1"/.test(m[1])) {
    const why = /data-disabled/.test(m[1]) ? 'config 关掉了该功能' : '这批文档没用到该功能';
    m[2].trim() === '' ? ok(`${id} 按需未内联（${why}）`)
      : fail(`${id} 标了按需未内联，块里却还有内容`);
    continue;
  }
  m[2].length > 10000 ? ok(`${id} 已整段内联（${(m[2].length / 1024 | 0)} KB）`) : fail(`${id} 是空块，离线版会渲染不出图`);
  !/<\/script/i.test(m[2]) ? ok(`${id} 块内没有裸的 </script`) : fail(`${id} 块内出现了裸的 </script`);
}
for (const id of ['mindmap-core', 'mermaid-core', 'md-core', 'md-app']) {
  html.includes(`<script id="${id}" src="assets/${id}.js"></script>`)
    ? ok(`产物外链 assets/${id}.js`) : fail(`产物没有外链 assets/${id}.js`);
}

console.log('[3] CSS');
const css = assetText('viewer.css');
const cssNoComment = css.replace(/\/\*[\s\S]*?\*\//g, '');
for (const [a, b, name] of [['{', '}', '花括号'], ['(', ')', '圆括号']]) {
  const n = (cssNoComment.split(a).length - 1) - (cssNoComment.split(b).length - 1);
  n === 0 ? ok(`${name}平衡`) : fail(`${name}差 ${n}`);
}
for (const s of ['--ease-out', 'body.left-hidden .sidebar', 'body.right-hidden .toc',
                 'visibility 0s linear var(--dur)', '.toc>*{width:calc(var(--right-w) - 1px)}',
                 'prefers-reduced-motion', 'html.preload', '.article.pop{animation:riseIn', '.toc-list{',
                 '.mm-stage', '.mm-canvas', '.mm-o-item', '.mm.mm-full', 'html.mm-full-on',
                 '.mg-block', '.mg-bar', '.mg-host', '.mg-error', '.mg-block.mg-full', 'html.mg-full-on']) {
  css.includes(s) ? ok('含 ' + s) : fail('缺 ' + s);
}

console.log('[4] 脚本语法');
/* 语法检查以模板 + 离线产物为对象：模板里的内联脚本、产物里填好的引擎块 */
for (const [label, text] of [['page.template.html', tpl], ['md-viewer.html', html]]) {
  const re = /<script id="([^"]+)"([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(text))) {
    const [, id, attrs, body] = m;
    if (/type="application\/json"/.test(attrs)) continue;   // JSON 在 [2] 里单独查
    if (/\ssrc="/.test(attrs)) continue;                    // 外链脚本单独查（见下）
    if (!body.trim()) continue;                             // 模板里的空占位块
    try { new vm.Script(body, { filename: label + '#' + id }); ok(`${label} 的 ${id} 语法通过`); }
    catch (e) { fail(`${label} 的 ${id} 语法错误：${e.message}`); }
  }
}
for (const f of ASSET_FILES.filter((x) => x.endsWith('.js'))) {
  try { new vm.Script(assetText(f), { filename: 'assets/' + f }); ok(`assets/${f} 语法通过`); }
  catch (e) { fail(`assets/${f} 语法错误：${e.message}`); }
}
if (!/^\s*$/.test(tpl)) ok('模板非空');

console.log('[5] 关键钩子');
for (const s of ['function popArticle()', 'function enableMotion()', 'popArticle();', 'enableMotion();',
                 "classList.remove('preload')", "fetch('config.json'", "fetch('docs-index.json'",
                 'var MindmapCore = (function ()', 'function renderMindmapDoc(', 'function renderMindmap(',
                 'function renderMindmapOutline(', 'function exportMindmapSvg(', 'function exportMindmapPng(',
                 'function isMindmapDoc(', 'window.markmap', 'id="mmSvgEl"',
                 'function setMindmapFullscreen(', 'function mmFullscreenOn(', 'id="mmFull"',
                 'var MermaidCore = (function ()', 'function mountMermaid(', 'function mgRenderOne(',
                 'function renderDiagramDoc(', 'function exportMermaidSvg(', 'function setMermaidFullscreen(',
                 'function mermaidEnabled(', 'function usesFence(', 'function diagramKind(']) {
  allCode.includes(s) ? ok('含 ' + s) : fail('缺 ' + s);
}
if (/\bdochelper\b/.test(allCode)) fail('还残留 dochelper 字样（应已改为工程内相对路径）');

console.log(bad ? `\n✗ ${bad} 项失败` : '\n✓ 全部通过');
process.exit(bad ? 1 : 0);
