/* =====================================================================
 * 产物完整性检查：内置快照 + docs-index.json
 *
 * 校验点：
 *   · 页面里能找到 <script id="docs-snapshot"> 并且 JSON 可解析
 *   · 快照里 < 都被转义成 \u003c（正文含 </script> 也不会提前闭合脚本）
 *   · 快照条目齐全：路径后缀与 kind 一致、标题与正文非空
 *   · 思维导图条目带 kind=mindmap，正文不是空壳
 *   · docs-index.json 不带正文，字段齐全，与快照篇数一致
 *   · 页面外链的 assets/ 脚本存在（自研代码已从页面里抽出去）
 *
 * 用法：node test/check-snapshot.mjs      （失败退出码 1）
 * 前置：先跑一次 node build-docs.mjs
 * ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEWER = path.join(ROOT, 'md-viewer.html');
const INDEX = path.join(ROOT, 'docs-index.json');

let fail = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? 'v' : 'x'} ${label}`);
  if (!ok) fail++;
};

const html = fs.readFileSync(VIEWER, 'utf8');
const m = /<script id="docs-snapshot" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
if (!m) { console.log('x 未找到快照块，先跑 node build-docs.mjs'); process.exit(1); }

let snap = null;
try { snap = JSON.parse(m[1]); } catch (e) { console.log('x 快照 JSON 解析失败：' + e.message); process.exit(1); }

console.log(`  快照：${snap.docs.length} 篇，忽略 ${snap.skipped} 个非 md 文件，生成于 ${snap.generatedAt}`);
console.log(`  正文合计：${snap.docs.reduce((n, d) => n + d.text.length, 0)} 字符`);

/* .mermaid 文件有两种：思维导图（mindmap 版式）与整篇图表（stateDiagram-v2 等）。
   判断规则直接用页面那份 assets/mermaid-core.js，避免这里另写一套版式清单。 */
const MermaidCore = (function loadCore() {
  const sandbox = { module: { exports: {} }, exports: null, console };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets', 'mermaid-core.js'), 'utf8'), sandbox);
  return sandbox.module.exports;
})();
const mmDocs = snap.docs.filter((d) => d.kind === 'mindmap');
const mdDocs = snap.docs.filter((d) => d.kind !== 'mindmap');
const mmDiagram = mmDocs.filter((d) => !!MermaidCore.diagramKind(d.text));
const mmMindmap = mmDocs.filter((d) => !mmDiagram.includes(d));

check(!m[1].includes('</script'), '快照 JSON 中没有裸的 "</script"');
check(snap.docs.every((d) => !d.text.includes('</script')), '没有文档的正文原样包含 </script>');
check(snap.docs.every((d) => d.path && d.title && d.text), '每条快照都有路径、标题、正文');
check(mdDocs.every((d) => /\.md$/i.test(d.path)), 'Markdown 条目都以 .md 结尾');
check(mmDocs.every((d) => /\.mermaid$/i.test(d.path)), `思维导图条目都以 .mermaid 结尾（${mmDocs.length} 篇）`);
check(mmMindmap.every((d) => /^\s*mindmap\s*$/im.test(d.text)),
  `${mmMindmap.length} 篇 .mermaid 是思维导图版式（正文里有 mindmap 声明）`);
check(mmDiagram.every((d) => MermaidCore.diagramKind(d.text).id !== 'unknown'),
  `${mmDiagram.length} 篇 .mermaid 是整篇图表（${mmDiagram.map((d) => d.name + ' → ' + MermaidCore.diagramKind(d.text).name).join('、') || '无'}）`);
check(!snap.kinds || (snap.kinds.markdown === mdDocs.length && snap.kinds.mindmap === mmDocs.length),
  `kinds 统计与条目一致（markdown ${mdDocs.length} / mindmap ${mmDocs.length}）`);
check(snap.count === snap.docs.length, `count 字段与实际条目一致（${snap.count}）`);
check(snap.docsRoot === 'docs/', `docsRoot 前缀为 docs/（实际 ${snap.docsRoot}）`);
const paths = snap.docs.map((d) => d.path);
check(new Set(paths).size === paths.length, '文档路径不重复');
check(snap.docs.every((d) => d.path.startsWith('docs/')), '所有路径都带 docs/ 前缀');

/* 引擎块清单直接读 build-docs.mjs，加/减引擎时这里跟着走，不会各写一份 */
function bundleIds() {
  const src = fs.readFileSync(path.join(ROOT, 'build-docs.mjs'), 'utf8');
  return [...src.matchAll(/\{\s*id:\s*'([^']+)',\s*file:/g)].map((x) => x[1]);
}

/* 引擎块的三种合法状态：
     · 正常内联 —— 块内有源码
     · data-disabled="1" —— config 把这个功能关了（mermaid.enabled = false）
     · data-unused="1"   —— 功能开着，但这批文档里没用到，离线版按需不内联
   页面侧靠 window.mermaid 是否存在自行降级，所以留空块是安全的。 */
const BUNDLE_IDS = bundleIds();
for (const id of BUNDLE_IDS) {
  const bm = new RegExp(`<script id="${id}"([^>]*)>([\\s\\S]*?)</script>`).exec(html);
  check(!!bm, `页面里有引擎块 ${id}`);
  if (!bm) continue;
  const off = /data-(disabled|unused)="1"/.test(bm[1]);
  if (off) {
    const why = /data-disabled/.test(bm[1]) ? 'config 里关掉了' : '这批文档没用到';
    check(bm[2].trim() === '', `${id} 未内联（${why}），块是空的`);
  } else {
    check(bm[2].length > 10000, `${id} 不是空块（${(bm[2].length / 1024 | 0)} KB）`);
    check(!/<\/script/i.test(bm[2]), `${id} 块内没有裸的 </script`);
  }
}
const tags = (html.match(/<script/g) || []).length;
/* 6 段固定脚本：配置、快照、mindmap-core、mermaid-core、md-core、md-app（后四段是 assets/ 外链） */
const BASE_SCRIPTS = 6;
check(tags === BASE_SCRIPTS + BUNDLE_IDS.length,
  `页面里 <script 标签共 ${BASE_SCRIPTS + BUNDLE_IDS.length} 个（配置 + 快照 + 4 段自研 + ${BUNDLE_IDS.length} 段引擎），实际 ${tags}`);
for (const id of ['viewer-config', 'docs-snapshot']) {
  check(html.includes(`<script id="${id}"`), `页面里有 <script id="${id}">`);
}
/* 自研脚本已抽到 assets/：页面只留外链，源码在 assets/<id>.js */
for (const id of ['mindmap-core', 'mermaid-core', 'md-core', 'md-app']) {
  const rel = `assets/${id}.js`;
  check(html.includes(`<script id="${id}" src="${rel}">`), `页面外链 <script id="${id}" src="${rel}">`);
  const full = path.join(ROOT, rel);
  const size = fs.existsSync(full) ? fs.statSync(full).size : 0;
  check(size > 1000, `${rel} 存在且不是空文件（${(size / 1024).toFixed(1)} KB）`);
}

if (!fs.existsSync(INDEX)) {
  check(false, 'docs-index.json 存在');
} else {
  const idx = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  console.log(`  索引：${idx.docs.length} 篇，生成于 ${idx.generatedAt}`);
  check(idx.docs.length === snap.docs.length, `索引篇数与快照一致（${idx.docs.length}）`);
  check(!idx.docs.some((d) => 'text' in d), '索引里没有正文（实时模式按需读取）');
  const fields = ['path', 'dir', 'name', 'kind', 'title', 'size', 'mtime'];
  check(idx.docs.every((d) => fields.every((f) => f in d)), '索引字段齐全：' + fields.join(', '));
  check(idx.docs.filter((d) => d.kind === 'mindmap').length === mmDocs.length,
    '索引里的思维导图篇数与快照一致');
  check(idx.docs.every((d, i) => d.path === paths[i]), '索引与快照的文档顺序一致');
}

console.log(fail ? `\n===== 失败 ${fail} 项 =====` : '\n===== 全部通过 =====');
process.exit(fail ? 1 : 0);
