/* =====================================================================
 * 嵌入 Mermaid 图表的回归（纯 Node，不需要浏览器）
 *
 * 覆盖三层：
 *   1. assets/mermaid-core.js —— 围栏识别、版式判定、块标记、源码原样保留
 *   2. assets/md-core.js 的接线 —— 传了 ctx.mermaid 就输出图表块，没传就还是普通代码块
 *      （后者是老行为，页面关掉该功能、以及 Node 侧老测试都靠它）
 *   3. build-docs.mjs 的产物 —— 引擎按需内联：文档里没有 Mermaid 图表时不留 3 MB 源码；
 *      有围栏（或 .mermaid 图表文档）时必须内联，否则离线版画不出来
 *
 * 用法：node test/verify-mermaid.mjs      （失败退出码 1）
 * 前置：先跑一次 node build-docs.mjs（第 3 层要读产物）
 * ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEWER = path.join(ROOT, 'md-viewer.html');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'mermaid');

let fail = 0;
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'v' : 'x'} ${label}${ok || detail === undefined ? '' : '   <- ' + detail}`);
  if (!ok) fail++;
};

/* ---------- 按页面的方式加载两份纯函数源码（经典脚本，末尾带 module.exports） ---------- */
function loadCore(rel) {
  const file = path.join(ROOT, rel);
  const sandbox = { module: { exports: {} }, exports: null, console };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  new vm.Script(fs.readFileSync(file, 'utf8'), { filename: rel }).runInContext(sandbox);
  return sandbox.module.exports;
}
const MG = loadCore('assets/mermaid-core.js');
const Core = loadCore('assets/md-core.js');

/* md-core 需要的 ctx（这里只测渲染分支，跨文档引用给空实现即可） */
function ctxFor(extra) {
  return Object.assign({
    docPath: 'docs/fixtures/mermaid/x.md',
    docHref: (p, s) => '#p=' + encodeURIComponent(p) + (s ? '&h=' + s : ''),
    resolveDoc: () => null,
    resolveAsset: (p) => p,
    sectionsOf: () => null,
  }, extra || {});
}

/* 页面确实外链了这两份源码，避免「源码改了页面没接线」 */
const viewer = fs.existsSync(VIEWER) ? fs.readFileSync(VIEWER, 'utf8') : '';
check(/<script id="mermaid-core" src="assets\/mermaid-core\.js">/.test(viewer), '页面外链 assets/mermaid-core.js');
check(/<script id="md-core" src="assets\/md-core\.js">/.test(viewer), '页面外链 assets/md-core.js');

/* ================= 1. 围栏识别 ================= */
console.log('\n--- 1. 围栏识别 ---');
const YES = [
  ['mermaid', '就写 mermaid'],
  ['Mermaid', '大小写不敏感'],
  ['MERMAID', '全大写'],
  ['mermaid title="状态机"', '带附加信息'],
  ['{.mermaid}', 'Pandoc 的 {.mermaid}'],
  ['{ .mermaid }', '带空格的 Pandoc 写法'],
  ['  mermaid  ', '两侧空白（md-core 会先 trim）'],
];
const NO = ['', 'mermaidfoo', 'javascript', 'js', 'mindmap', 'mmd', '.mermaid', '{.mmd}', '```mermaid'];
for (const [info, label] of YES) check(MG.isFence(info) === true, `认作 mermaid 围栏：${label}`);
for (const info of NO) check(MG.isFence(info) === false, `不认作 mermaid 围栏：${JSON.stringify(info)}`);
check(MG.isFence('```mermaid') === false, '传进来的是「信息串」而不是整行（反引号由 md-core 剥掉）');

check(MG.usesFence('前言\n\n```mermaid\nstateDiagram-v2\n```\n') === true, 'usesFence 找得到正文里的围栏');
check(MG.usesFence('```js\nvar a = 1;\n```\n') === false, 'usesFence 不会把 js 围栏当 Mermaid');
check(MG.usesFence('~~~mermaid\nflowchart TD\n~~~\n') === true, 'usesFence 支持 ~~~ 围栏');
check(MG.usesFence('````mermaid\nflowchart TD\n````\n') === true, 'usesFence 支持四个反引号');
check(MG.usesFence('```\n```mermaid\n```\n') === false, '围栏内的 ```mermaid 是内容，不算图表');

/* ================= 2. 版式判定 ================= */
console.log('\n--- 2. 版式判定 ---');
const kinds = [
  ['stateDiagram-v2\n    [*] --> A', 'statediagram-v2', '状态图'],
  ['stateDiagram\n    [*] --> A', 'statediagram', '状态图'],
  ['flowchart TD\n  A --> B', 'flowchart', '流程图'],
  ['graph LR\n  A --> B', 'graph', '流程图'],
  ['sequenceDiagram\n  A->>B: hi', 'sequencediagram', '时序图'],
  ['classDiagram\n  A --> B', 'classdiagram', '类图'],
  ['erDiagram\n  A ||--o{ B : has', 'erdiagram', '实体关系图'],
  ['gantt\n  title x', 'gantt', '甘特图'],
  ['pie title x\n  "a" : 1', 'pie', '饼图'],
  ['mindmap\n  root((x))\n    a', 'mindmap', '思维导图'],
];
for (const [src, id, label] of kinds) {
  const k = MG.kind(src);
  check(k.id === id && k.label === label, `${src.split('\n')[0]} → ${id} / ${label}（实际 ${k.id} / ${k.label}）`);
}
/* 顺序：statediagram-v2 不能被 statediagram 抢走 */
check(MG.kind('stateDiagram-v2\n[*] --> A').keyword === 'stateDiagram-v2', 'stateDiagram-v2 的 keyword 不被截断');
/* 注释、init 指令、前置配置块、空行都不算「第一行」 */
check(MG.kind('%%{init: {"theme":"dark"}}%%\nstateDiagram-v2\n[*] --> A').id === 'statediagram-v2',
  '跳过 %%{init}%% 指令行');
check(MG.kind('%% 注释\n\nstateDiagram-v2\n[*] --> A').id === 'statediagram-v2', '跳过注释与空行');
check(MG.kind('---\ntitle: x\n---\nstateDiagram-v2\n[*] --> A').id === 'statediagram-v2', '跳过 --- 前置配置块');
check(MG.kind('').id === 'empty', '空内容 → empty');
check(MG.kind('这不是 mermaid').id === 'unknown', '认不出的第一行 → unknown（仍交给引擎试画）');

/* diagramKind：.mermaid 整篇文件要不要走图表渲染 */
check(MG.diagramKind('stateDiagram-v2\n[*] --> A').id === 'statediagram-v2', '.mermaid 里的 stateDiagram-v2 → 图表');
check(MG.diagramKind('mindmap\n  root((x))') === null, '.mermaid 里的 mindmap 仍走思维导图');
check(MG.diagramKind('随便写点什么') === null, '认不出内容时交回思维导图那条路（有更贴切的报错）');
check(MG.diagramKind('') === null, '空文件不抢思维导图的处理');

/* ================= 3. 块标记与源码保真 ================= */
console.log('\n--- 3. 块标记与源码保真 ---');
const SRC = 'stateDiagram-v2\n    [*] --> IDLE\n    IDLE --> RUN : 启动\n    RUN --> [*] : <done> & "收尾"';
const htmlOf = (src, opts) => MG.block(src, 'mermaid', 1, opts);

const blockHtml = htmlOf(SRC);
check(/^<div class="mg-block"/.test(blockHtml), '块以 <div class="mg-block"> 开头');
check(blockHtml.includes('data-mg-kind="statediagram-v2"'), '块上带版式标记');
check(blockHtml.includes('data-mg-index="1"'), '块上带序号（导出文件名/测试定位都用它）');
check(blockHtml.includes('<div class="mg-host"'), '有渲染落点 .mg-host');
check(blockHtml.includes('<pre class="code"><code>'), '源码放在 <pre class="code"><code> 里（md-viewer 的既有排版与测试都认这个写法）');
check(blockHtml.includes('data-mg-act="src"') && blockHtml.includes('data-mg-act="copy"'), '工具栏含 源码 / 复制');
check(blockHtml.includes('data-mg-act="svg"') && blockHtml.includes('data-mg-act="full"'), '工具栏含 SVG / 全屏');

check(MG.block(SRC, 'mermaid', 1, { controls: false }).includes('mg-bar') === false, 'controls=false 时不给工具栏');
const noExport = MG.block(SRC, 'mermaid', 1, { exportImage: false });
check(!noExport.includes('data-mg-act="svg"') && noExport.includes('data-mg-act="full"'), 'exportImage=false 只去掉导出按钮');
const noFull = MG.block(SRC, 'mermaid', 1, { fullscreen: false });
check(!noFull.includes('data-mg-act="full"') && noFull.includes('data-mg-act="svg"'), 'fullscreen=false 只去掉全屏按钮');

/* 源码必须能原样取回：HTML 实体 + textContent 解码后应与归一化后的源码一致 */
const encoded = /<pre class="code"><code>([\s\S]*?)<\/code><\/pre>/.exec(blockHtml)[1];
const decoded = encoded.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
check(decoded === MG.normalize(SRC), '源码经 HTML 转义后能逐字还原', decoded);
check(encoded.includes('&lt;done&gt;') && encoded.includes('&amp;'), '尖括号与 & 都被转义（块里不可能出现裸标签）');
check(!/<script/i.test(blockHtml), '块里不会出现 <script');

/* 归一化：BOM、CRLF、行尾空白、首尾空行都不影响渲染，但内容不能改 */
check(MG.normalize('\uFEFFa\r\nb  \r\n\r\n') === 'a\nb', 'normalize 处理 BOM / CRLF / 行尾空白 / 尾空行');
check(MG.normalize('  stateDiagram-v2\n    [*] --> A  ') === '  stateDiagram-v2\n    [*] --> A',
  'normalize 保留缩进（Mermaid 靠缩进表达组合状态）');

/* make(cfg)：页面用的绑定版本，把 config 固化成 opts */
const made = MG.make({ controls: true, exportImage: false, fullscreen: false });
check(made.isFence('mermaid') === true && made.isFence('js') === false, 'make() 返回的 isFence 可用');
const madeHtml = made.block(SRC, 'mermaid', 2);
check(madeHtml.includes('data-mg-index="2"') && !madeHtml.includes('data-mg-act="svg"'), 'make() 把 config 固化进块标记');

/* ================= 4. 与 md-core 的接线 ================= */
console.log('\n--- 4. 与 md-core 的接线 ---');
const MD = [
  '# 标题',
  '',
  '正文一段。',
  '',
  '```mermaid',
  'stateDiagram-v2',
  '    [*] --> A',
  '    A --> B : 走',
  '```',
  '',
  '```js',
  'var a = 1;',
  '```',
].join('\n');

const plain = Core.render(MD, ctxFor()).html;
check(plain.includes('<pre class="code"><code class="language-mermaid">stateDiagram-v2'),
  '不传 ctx.mermaid 时，围栏还是普通代码块（老行为不变）');
check((plain.match(/class="mg-block"/g) || []).length === 0, '不传 ctx.mermaid 时不会出现图表块');
check(plain.includes('language-js'), '其它语言的围栏不受影响');

const withMg = Core.render(MD, ctxFor({ mermaid: MG.make({}) })).html;
check((withMg.match(/class="mg-block"/g) || []).length === 1, '传了 ctx.mermaid 时，```mermaid 变成图表块');
check(withMg.includes('data-mg-index="1"'), '图表块序号从 1 开始');
check(withMg.includes('<pre class="code"><code class="language-js">var a = 1;'), 'js 围栏仍是普通代码块');
check(Core.render(MD, ctxFor({ mermaid: MG.make({}) })).headings.length === 1, '图表块不影响标题扫描');

/* 页面关掉该功能时：ctx.mermaid 为 null，行为与从前一致 */
check(Core.render(MD, ctxFor({ mermaid: null })).html.includes('<pre class="code"><code class="language-mermaid">'),
  'config 关掉后围栏退回代码块');

/* 一个块坏了不该影响后面的块：这里只验证两块都被标记出来 */
const two = ['```mermaid', 'stateDiagram-v2', '[*] --> A', '```', '', '```mermaid', 'flowchart TD', 'A --> B', '```'].join('\n');
const twoHtml = Core.render(two, ctxFor({ mermaid: MG.make({}) })).html;
check((twoHtml.match(/data-mg-index="/g) || []).length === 2, '同一篇文档里的多张图各占一个块');

/* ================= 5. fixtures 边界（同时被 verify-render 扫一遍） ================= */
console.log('\n--- 5. fixtures ---');
if (fs.existsSync(FIXTURES)) {
  const files = fs.readdirSync(FIXTURES).filter((f) => /\.md$/i.test(f));
  check(files.length > 0, `test/fixtures/mermaid/ 下有 ${files.length} 个用例`);
  /* 与 md-core 一致的扫描：行首 0~3 空格、引用块的 >、以及 mermaid / {.mermaid} 信息串 */
  const FENCE_RE = /^ {0,4}(?:> ?)*(`{3,}|~{3,})[ \t]*(mermaid\b|\{\.?mermaid\})/gim;
  for (const f of files) {
    const text = fs.readFileSync(path.join(FIXTURES, f), 'utf8');
    const h = Core.render(text, ctxFor({ mermaid: MG.make({}) })).html;
    const fences = (text.replace(/\r\n?/g, '\n').match(FENCE_RE) || []).length;
    const blocks = (h.match(/class="mg-block"/g) || []).length;
    const isMermaidDoc = new RegExp(FENCE_RE.source, 'im').test(text);
    const ok = isMermaidDoc ? blocks === fences : blocks === 0;
    check(ok, `${f}：图表块数 ${blocks} 与源码围栏数 ${fences} 一致`);
  }
} else {
  check(false, '缺少 test/fixtures/mermaid/ 目录');
}

/* ================= 6. 产物：引擎按需内联 ================= */
console.log('\n--- 6. 产物（按需内联） ---');
if (!viewer) {
  check(false, '还没生成 md-viewer.html，先跑 node build-docs.mjs');
} else {
  const snapM = /<script id="docs-snapshot" type="application\/json">([\s\S]*?)<\/script>/.exec(viewer);
  const snap = JSON.parse(snapM[1]);
  const needEngine = snap.docs.some((d) => (d.kind === 'mindmap'
    ? !!MG.diagramKind(d.text)
    : MG.usesFence(d.text)));
  const m = /<script id="vendor-mermaid"([^>]*)>([\s\S]*?)<\/script>/.exec(viewer);
  check(!!m, '页面里有 vendor-mermaid 块');
  if (m) {
    const off = /data-(disabled|unused)="1"/.test(m[1]);
    if (needEngine) {
      check(!off, '这批文档里有 Mermaid 图表 → 引擎必须内联（不能留空块）');
      check(m[2].length > 100000, `引擎已内联（${(m[2].length / 1024 | 0)} KB）`);
    } else {
      check(off && m[2].trim() === '', '这批文档里没有 Mermaid 图表 → 引擎按需不内联，离线单文件保持小体积');
    }
  }
  /* 产物里那份规则必须与 mermaid-core 的一致：构建脚本引用它，不另写一套 */
  const buildSrc = fs.readFileSync(path.join(ROOT, 'build-docs.mjs'), 'utf8');
  check(buildSrc.includes("loadAssetModule('assets/mermaid-core.js')"),
    'build-docs.mjs 复用 assets/mermaid-core.js 的判定（没有另写一份版式清单）');
  const needFn = /function needsMermaidEngine\(docs\)\s*\{([\s\S]*?)\n\}/.exec(buildSrc);
  check(!!needFn, 'build-docs.mjs 里有 needsMermaidEngine()');
  check(!!needFn && !/(stateDiagram|sequenceDiagram|flowchart|classDiagram|erDiagram|gantt|gitGraph)/.test(needFn[1]),
    'needsMermaidEngine 里没有硬编码版式关键字（改用 mermaid-core 的 kind/usesFence）');
}

console.log(fail ? `\n===== 失败 ${fail} 项 =====` : '\n===== 全部通过 =====');
process.exit(fail ? 1 : 0);
