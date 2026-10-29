#!/usr/bin/env node
/* =====================================================================
 * markdown-docs-helper —— build-docs.mjs
 * 由 page.template.html 生成两个页面（离线单文件版 + 实时服务版），或启动本地实时服务。
 *
 * 重要：本脚本【只读】文档目录，绝不修改、移动、删除任何 .md／.mermaid 文档。
 *       只有明确的构建命令（不带 --serve / --check）才写文件，写入被限制在本工程内，
 *       且不允许写进文档目录（见 assertInsideRoot）：
 *         · md-viewer.html   —— 离线单文件版：把配置、文档快照、引擎源码都填进模板的占位块
 *         · index.html       —— 实时服务版：同一模板、同一份数据，引擎改成本地外链、快照置空
 *         · docs-index.json  —— 最后一次构建的文档索引（实时服务用的是每次现扫的索引，不读这个文件）
 *         · config.json      —— 仅在缺失时生成默认配置
 *       --serve 与 --check 不写任何文件：--serve 把实时版页面放在内存里响应，
 *       --check 只做比对。所以 --serve 指定哪个目录，都不会顶掉上面这些产物。
 *       唯一的例外是 VERSION：它只由 --stamp-version / --install-hook 写，
 *       构建本身也只读它，把里面那行版本串填进产物的 build-info 占位块。
 *
 * 两种页面（都不联网，只用工程内的本地资源）：
 *   md-viewer.html  离线单文件：引擎整段内联，file:// 双击即可看（构建时刷新）
 *   index.html      实时服务版：引擎走本地外链，浏览器可缓存（构建时一并生成，
 *                   是 --serve 的默认入口；不要手工编辑，改 page.template.html 即可）
 *   两个产物都由 page.template.html 生成，页面结构只维护这一份模板。
 *   页面里只引用工程内的本地资源（assets/*、vendor/markmap/*），不碰任何互联网资源。
 *
 * 用法：
 *   node build-docs.mjs                       # 扫描 ./docs，刷新三个产物（页面内置数据 + index.html）
 *   node build-docs.mjs <目录>                 # 扫描任意目录（页面内路径前缀仍为 docs/）
 *   node build-docs.mjs --check [目录]         # 只检查是否过期（过期退出码 1），不写文件
 *   node build-docs.mjs --serve [目录]         # 启动本地实时服务（默认 8899，绑不上就往后顺延）
 *                                             #   访问 / 即进实时版；不写任何文件
 *   node build-docs.mjs --serve --port 9000 [目录]
 *   node build-docs.mjs --serve --lan [目录]   # 绑定所有网卡（0.0.0.0），同一局域网内可访问
 *   node build-docs.mjs --serve --host 192.168.1.20 [目录]   # 只绑定指定的本机地址
 *   node build-docs.mjs --exclude a/b [--exclude xxx] [目录] # 跳过文档目录下的子目录/单个文件（可写多次）
 *   node build-docs.mjs --stamp-version          # 只刷 VERSION（package.json 的 version+提交短哈希）
 *   node build-docs.mjs --install-hook           # 把 --stamp-version 装成 pre-commit 钩子，提交时自动刷
 *   node build-docs.mjs --help
 *
 * 目录位置随意（写在参数前后都行），但最多只能写一个；不写就是工程自带的 ./docs。
 * 参数写错会直接报错退出，绝不会被静默忽略：未知参数、多余目录、坏的端口号、坏的监听地址都会拦下。
 *
 * --exclude（可写多次）：路径相对文档目录，按路径前缀排除，目录与单个文件都可以。
 *   例如 node build-docs.mjs --exclude xxx --exclude a/b --serve ./
 *   会跳过 ./xxx/、./a/b/ 下的全部文件（a/ 下其它文件照常扫描）。
 *   构建、--check、--serve 三种模式都生效；绝对路径和用 .. 跳出文档目录的写法会被拒绝。
 *   与 config.json 的 sidebar.exclude 不同：后者只是左栏不显示，文档仍会进索引与搜索。
 *
 * 监听地址（--serve 专用）：默认只绑 127.0.0.1，也就是只有本机能打开。
 *   --lan            = --host 0.0.0.0，绑定所有网卡，启动时会把局域网地址印出来；
 *   --host <地址>     绑定单个地址（IP 或主机名，如 0.0.0.0、::、192.168.1.20、localhost）。
 *   服务没有任何鉴权，--lan / --host 0.0.0.0 只适合在可信内网里用。
 *
 * 配置文件：config.json（标题、首页说明、左栏显示哪些文档、右侧目录层级等）。
 *           支持 // 与 /* *\/ 注释和尾随逗号；写错时页面会显示红色提示。
 *
 * 版本文件：VERSION（一行，形如 1.0.3+20a7f73 = package.json 的 version + 提交短哈希）。
 *           由 --stamp-version 写、由 pre-commit 钩子在每次提交时自动刷新，构建只读它，
 *           顶栏「关于」显示的就是这一行。pre-commit 时新提交的哈希还不存在，
 *           所以记进去的是它的父提交：版本串里的提交标记天然落后一次提交，不是写错。
 *
 * 两种浏览方式：
 *   1) 直接双击 md-viewer.html（file://）——使用页面内置数据，零依赖、可离线；
 *      文档变动后重跑本脚本刷新。
 *   2) node build-docs.mjs --serve —— 打开 http://127.0.0.1:<端口>/ （即 index.html），
 *      实时读取文档目录下的 .md，新增/修改文档刷新页面即生效，无需重新构建；
 *      这一版页面在内存里现生成，--serve 全程不落盘；
 *      想给同一局域网里的同事看，加 --lan（等价于 --host 0.0.0.0）。
 * ===================================================================== */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));   // 工程根
/* 页面侧的纯函数模块在构建期也要用，保证「构建怎么判断」与「页面怎么渲染」永远同一套规则。
   注意 assets/*.js 是给浏览器用的经典脚本（末尾带 module.exports 便于 Node 测试），
   而本工程是 "type": "module"，直接 require 会被当成 ESM —— 所以按经典脚本就地求值。 */
function loadAssetModule(rel) {
  const file = path.join(ROOT, rel);
  const sandbox = { module: { exports: {} }, exports: null, console };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return sandbox.module.exports;
}
const MermaidCore = loadAssetModule('assets/mermaid-core.js');
/* 页面里的文档路径前缀。固定为 docs/，与文档的真实位置无关：
   即使用命令行指定了别的目录，config.json 里的 folders/exclude/docs 也不用改。 */
const VIRTUAL_ROOT = 'docs';
const DEFAULT_DOCS_DIR = path.join(ROOT, 'docs');
let DOCS_DIR = DEFAULT_DOCS_DIR;
let EXCLUDES = [];              // --exclude 的归一化路径（相对文档目录、posix、无首尾斜杠）
const VIEWER = path.join(ROOT, 'md-viewer.html');       // 离线单文件版（生成物，随仓库提交）
const INDEX_HTML = path.join(ROOT, 'index.html');       // 实时服务版（生成物，构建时刷新；--serve 只用内存里的同一份）
const TEMPLATE = path.join(ROOT, 'page.template.html'); // 两个页面唯一的布局来源
const INDEX = path.join(ROOT, 'docs-index.json');
const CONFIG = path.join(ROOT, 'config.json');
const HELP_DIR = path.join(ROOT, 'help');           // 帮助对话框的每一页：一个 .md
const PKG = path.join(ROOT, 'package.json');
const VERSION_FILE = path.join(ROOT, 'VERSION');    // 每次提交由 pre-commit 钩子刷新，见 --stamp-version
const SNAPSHOT_RE = /(<script id="docs-snapshot" type="application\/json">)([\s\S]*?)(<\/script>)/;
const CONFIG_RE = /(<script id="viewer-config" type="application\/json">)([\s\S]*?)(<\/script>)/;
const BUILD_INFO_RE = /(<script id="build-info" type="application\/json">)([\s\S]*?)(<\/script>)/;
const DEFAULT_PORT = 8899;
/* 默认只听环回：不给参数就不会把文档暴露到网络上。--lan / --host 才对外。 */
const DEFAULT_HOST = '127.0.0.1';
const LAN_HOST = '0.0.0.0';         // --lan 的等价写法：所有网卡
const VENDOR_MARKMAP = path.join(ROOT, 'vendor', 'markmap');
const VENDOR_MERMAID = path.join(ROOT, 'vendor', 'mermaid');

/* 页面里的引擎块。模板里只有空占位，构建时按产物填不同内容：
     离线版 md-viewer.html —— 整段内联（file:// 页面加载不了外部脚本）
     实时版 index.html     —— 换成 vendor/ 下的本地外链（浏览器可缓存）
   顺序很重要：markmap-view 的浏览器构建是 (this.markmap, d3) 形式的 IIFE，
   依赖全局 d3 已经存在，所以 d3 必须排在最前面；mermaid 自成一体，放最后。
   on(cfg) 返回 false 的引擎会被跳过：两个产物里都只留一个带 data-disabled="1"
   的空块 —— 这样关掉功能就真的不给页面塞几个 MB 的引擎，围栏退回普通代码块。
   注意：{ id, file } 的键序不要改，test/check-snapshot.mjs 是按这个形状读清单的。 */
const BUNDLES = [
  { id: 'vendor-d3', file: 'd3.min.js', dir: VENDOR_MARKMAP, role: 'd3' },
  { id: 'vendor-markmap-lib', file: 'markmap-lib.iife.js', dir: VENDOR_MARKMAP, role: 'markmap-lib' },
  { id: 'vendor-markmap-view', file: 'markmap-view.browser.js', dir: VENDOR_MARKMAP, role: 'markmap-view' },
  {
    id: 'vendor-mermaid', file: 'mermaid.min.js', dir: VENDOR_MERMAID, role: 'mermaid',
    on: (cfg) => mermaidEnabled(cfg),
    /* 按需内联：只有这次构建的文档里真的出现了 Mermaid 图表才把引擎塞进离线单文件。
       没用到时离线版留空块（标 data-unused="1"），md-viewer.html 仍是 1 MB 上下；
       实时版照旧本地外链（文档可能随时新增围栏，外链可缓存、不占体积）。 */
    need: (ctx) => !!ctx.needMermaid,
  },
];
const bundleRe = (id) => new RegExp(`(<script id="${id}">)([\\s\\S]*?)(</script>)`);
const VENDOR_REL = (b) => path.relative(ROOT, path.join(b.dir, b.file)).split(path.sep).join('/');
const vendorTag = (b) => `<script id="${b.id}" src="${VENDOR_REL(b)}"></script>`;
/* 文档目录里哪些后缀算「文档」：.md 按 Markdown 渲染，.mermaid 按思维导图渲染 */
const DEFAULT_MINDMAP_EXT = ['.mermaid'];

/** 思维导图总开关（config.mindmap.enabled = false 时 .mermaid 只当普通文本） */
function mindmapEnabled(cfg) {
  return !(cfg && cfg.mindmap && cfg.mindmap.enabled === false);
}

/** 嵌入 Mermaid 图表总开关（config.mermaid.enabled = false 时围栏退回普通代码块） */
function mermaidEnabled(cfg) {
  return !(cfg && cfg.mermaid && cfg.mermaid.enabled === false);
}

/** 这次构建的文档里有没有 Mermaid 图表（决定离线单文件要不要内联那 3 MB 的引擎）：
    · .md —— 正文里有 ```mermaid 围栏
    · .mermaid —— 整篇写的是 mindmap 以外的版式（stateDiagram-v2 / flowchart…）
    判断规则来自 assets/mermaid-core.js（页面用的同一份），此处不另写一套。 */
function needsMermaidEngine(docs) {
  return docs.some((d) => (d.kind === 'mindmap'
    ? !!MermaidCore.diagramKind(d.text)
    : MermaidCore.usesFence(d.text)));
}

/* ---------- 安全护栏：写操作只能落在工程内，且绝不能碰文档目录 ---------- */
function assertInsideRoot(target) {
  const p = path.resolve(target);
  const rel = path.relative(ROOT, p);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`拒绝写入本工程之外的路径：${target}`);
  }
  const relDocs = path.relative(DOCS_DIR, p);
  if (!relDocs.startsWith('..') && !path.isAbsolute(relDocs)) {
    throw new Error(`拒绝写入文档目录（本工具是只读的）：${target}`);
  }
}

/* ---------- 扫描文档目录（只读） ---------- */
/* --exclude 写的是相对文档目录的路径：统一成 posix 形式（Windows 的反斜杠也认），
   去掉 ./ 前缀与尾部斜杠，方便按路径前缀比较。空值、绝对路径、.. 都当场报错。 */
function normalizeExclude(raw) {
  const p = String(raw).replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!p || p === '.') {
    cliError('--exclude 后面要跟相对文档目录的路径，例如：--exclude a/b');
  }
  if (/^(\/|[A-Za-z]:\/)/.test(p)) {
    cliError(`--exclude 只接受相对文档目录的路径，不要写绝对路径：${raw}`);
  }
  if (p.split('/').includes('..')) {
    cliError(`--exclude 不能用 .. 跳出文档目录：${raw}`);
  }
  return p.split('/').filter(Boolean).join('/');
}

/* Windows / macOS 的文件系统默认不区分大小写，排除路径也跟着不区分 */
const EXCLUDE_CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';
const excludeKey = (s) => (EXCLUDE_CASE_INSENSITIVE ? s.toLowerCase() : s);

/* 命中规则：路径相同，或位于被排除目录之下（按路径分段比较，a/b 不会误伤 a/bc） */
function isExcluded(rel) {
  const key = excludeKey(rel);
  return EXCLUDES.some((ex) => {
    const k = excludeKey(ex);
    return key === k || key.startsWith(k + '/');
  });
}

async function walk(dir, base = '') {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (isExcluded(rel)) continue;   // 目录在递归前剪枝：子文件不会被读取，也不计入扫描数
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, rel)));
    else out.push({ rel, full, name: e.name });
  }
  return out;
}

function titleOf(text, fallback) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  let fence = null;
  for (const line of lines) {
    const fm = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fm) {
      const ch = fm[1][0];
      if (!fence) fence = ch;
      else if (ch === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const m = /^ {0,3}#[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(line);
    if (m) return m[1].trim();
  }
  return fallback;
}

/* ---------- 帮助文档（只读） ----------
   帮助对话框的正文不写在模板里：help/ 下每页一个 .md，构建时整份读进页面，
   按文件名排序（数字前缀决定页签顺序），页签标题取每篇的第一个 H1。 */
async function readHelpPages() {
  let entries;
  try {
    entries = await fsp.readdir(HELP_DIR, { withFileTypes: true });
  } catch (e) {
    throw new Error(`找不到帮助文档目录：${path.relative(ROOT, HELP_DIR) || 'help'}`);
  }
  const files = entries
    .filter((e) => e.isFile() && /\.md$/i.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  if (!files.length) {
    throw new Error(`帮助文档目录 ${path.relative(ROOT, HELP_DIR)} 里没有 .md 文件`);
  }
  const pages = [];
  for (const name of files) {
    const text = (await fsp.readFile(path.join(HELP_DIR, name), 'utf8')).replace(/^\uFEFF/, '');
    const fallback = name.replace(/\.md$/i, '').replace(/^\d+[-_.\s]*/, '');
    pages.push({ title: titleOf(text, fallback), md: text });
  }
  return pages;
}

function sortDocs(docs) {
  const dirRank = (d) => (d.dir === '.' ? '' : d.dir);
  return docs.sort((a, b) =>
    dirRank(a).localeCompare(dirRank(b), 'zh-Hans-CN') ||
    a.path.localeCompare(b.path, 'zh-Hans-CN'));
}

/** 把 config.mindmap.extensions 归一成小写后缀数组（如 ['.mermaid']） */
function mindmapExts(cfg) {
  const mm = (cfg && cfg.mindmap) || {};
  const list = Array.isArray(mm.extensions) && mm.extensions.length ? mm.extensions : DEFAULT_MINDMAP_EXT;
  return list
    .map((e) => String(e).trim().toLowerCase())
    .filter(Boolean)
    .map((e) => (e.startsWith('.') ? e : '.' + e));
}

/** 思维导图标题：优先根节点文本（`root((文本))` / `root[文本]`），否则用文件名 */
function mindmapTitle(text, fallback) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  let seenHeader = false;
  for (const raw of lines) {
    if (/^\s*%%/.test(raw)) continue;                       // 注释与 init 指令
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (!seenHeader) {
      if (!/^\s*mindmap\s*$/i.test(line)) continue;         // 不是 mindmap 版式就不猜标题
      seenHeader = true;
      continue;
    }
    const node = parseNodeLine(line.slice(leadingChars(line)));
    if (node) return node.text || fallback;
    break;
  }
  return fallback;
}

/* 行首空白占几个字符。注意与「缩进宽度」区分：tab 是 1 个字符、4 列宽，
   用列宽去 slice 字符串会把正文开头的字吃掉。 */
function leadingChars(s) {
  let n = 0;
  while (n < s.length && (s[n] === ' ' || s[n] === '\t')) n += 1;
  return n;
}

/* 单行节点：`root((文本))`、`id[文本]`、`((根))`、`{{六边}}`、`)云(` … 只取展示文本。
   与 md-viewer.html 里 mindmap-core 的规则保持一致：id 只认 ASCII 标识符，
   避免把中文节点文字（`制表符分支`）当成 id 丢掉。 */
function parseNodeLine(s) {
  s = s.replace(/\s+$/, '');
  if (!s) return null;
  let token = '';
  for (;;) {
    const shaped = shapeText(s);
    if (shaped) return shaped;
    const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*([([{)\]][\s\S]*)$/.exec(s);
    if (!m) return { text: cleanNodeText(s) };
    token = m[1];
    s = m[2];
  }
}

function pair(s, prefix, suffix) {
  if (s.slice(0, prefix.length) !== prefix) return false;
  if (suffix === null) return s.length > prefix.length;
  if (s.length < prefix.length + suffix.length + 1) return false;
  return s.slice(-suffix.length) === suffix;
}

function shapeText(s) {
  /* 顺序要紧：先长后短，`))x((` 必须比 `)x(` 先匹配 */
  const shapes = [['((', '))'], ['{{', '}}'], ['))', '(('], ['[', ']'], ['{', '}'], [')(', null], ['(', ')']];
  for (const [pre, suf] of shapes) {
    if (!pair(s, pre, suf)) continue;
    return { text: cleanNodeText(s.slice(pre.length, suf === null ? undefined : -suf.length)) };
  }
  return null;
}

/* 去掉包裹文字的引号 */
function cleanNodeText(s) {
  const t = String(s).trim();
  const m = /^"([\s\S]*)"$/.exec(t);
  return (m ? m[1] : t).trim();
}


/** 扫描并读取文档目录下所有 markdown 与思维导图（withText=false 时不带正文，供实时索引使用） */
async function collect({ withText = true, kinds = { md: true, mindmap: DEFAULT_MINDMAP_EXT } } = {}) {
  if (!fs.existsSync(DOCS_DIR)) throw new Error(`找不到文档目录：${DOCS_DIR}`);
  const mmExt = kinds.mindmap || [];
  const files = await walk(DOCS_DIR);
  const picked = files.filter((f) => {
    const lower = f.name.toLowerCase();
    if (/\.md$/i.test(f.name)) return !!kinds.md;
    return mmExt.some((e) => lower.endsWith(e));
  });
  const skipped = files.length - picked.length;
  const docs = [];
  for (const f of picked) {
    const kind = /\.md$/i.test(f.name) ? 'markdown' : 'mindmap';
    const st = await fsp.stat(f.full);
    const vpath = `${VIRTUAL_ROOT}/${f.rel}`;
    const extless = f.name.replace(/\.[^.]+$/, '');
    const rec = {
      path: vpath,
      dir: path.posix.dirname(vpath),
      name: f.name,
      kind,
      size: st.size,
      mtime: st.mtime.toISOString(),
      title: extless,
    };
    const text = await fsp.readFile(f.full, 'utf8');
    rec.title = kind === 'mindmap' ? mindmapTitle(text, rec.title) : titleOf(text, rec.title);
    if (withText) rec.text = text;
    docs.push(rec);
  }
  return { docs: sortDocs(docs), skipped, files: files.length, md: picked.length };
}

function countKinds(docs) {
  const out = { markdown: 0, mindmap: 0 };
  docs.forEach((d) => { out[d.kind === 'mindmap' ? 'mindmap' : 'markdown'] += 1; });
  return out;
}

/* 页面「数据来源」里显示的扫描目录：工程内写成相对路径（docs），工程外给绝对路径 */
function docsDirLabel() {
  const rel = path.relative(ROOT, DOCS_DIR);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel)
    ? rel.split(path.sep).join('/')
    : DOCS_DIR;
}

function snapshotPayload(docs, skipped) {
  return {
    generatedAt: new Date().toISOString(),
    docsRoot: VIRTUAL_ROOT + '/',
    docsDir: docsDirLabel(),
    count: docs.length,
    kinds: countKinds(docs),
    skipped,
    docs,
  };
}

function indexPayload(docs, skipped) {
  return {
    generatedAt: new Date().toISOString(),
    docsRoot: VIRTUAL_ROOT + '/',
    docsDir: docsDirLabel(),
    count: docs.length,
    kinds: countKinds(docs),
    skipped,
    docs: docs.map((d) => ({
      path: d.path, dir: d.dir, name: d.name, kind: d.kind,
      title: d.title, size: d.size, mtime: d.mtime,
    })),
  };
}

/* "<" 转义为 \u003c，避免正文中出现 </script> 提前闭合脚本标签 */
function renderSnapshot(payload) { return JSON.stringify(payload).replace(/</g, '\\u003c'); }
function renderConfig(payload) { return JSON.stringify(payload).replace(/</g, '\\u003c'); }
function renderHelp(pages) { return JSON.stringify(pages).replace(/</g, '\\u003c'); }
function renderIndex(payload) { return JSON.stringify(payload, null, 2); }

/* 递归排序对象键，用于与顺序无关的内容比较 */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out = {};
    Object.keys(v).sort().forEach((k) => { out[k] = canonical(v[k]); });
    return out;
  }
  return v;
}
const canonOf = (v) => JSON.stringify(canonical(v));

/* --check 比较时忽略 generatedAt，否则刚构建完也会被判为过期 */
function contentSignature(payload) {
  const copy = JSON.parse(JSON.stringify(payload));
  delete copy.generatedAt;
  return canonOf(copy);
}
function isStale(existingText, freshPayload) {
  try { return contentSignature(JSON.parse(existingText)) !== contentSignature(freshPayload); }
  catch (e) { return true; }
}
function isConfigStale(existingText, fresh) {
  try { return canonOf(JSON.parse(existingText)) !== canonOf(fresh); }
  catch (e) { return true; }
}
/* 整页逐字比对前，先把快照里的 generatedAt 抹平：它每次构建都变，不代表内容过期 */
function pageSignature(html) {
  return createHash('sha1').update(html.replace(/("generatedAt"\s*:\s*")[^"]*(")/, '$1$2')).digest('hex');
}

/* ---------- config.json：允许注释与尾随逗号 ---------- */
function parseJsonc(text) {
  const src = String(text).replace(/^\uFEFF/, '');
  let out = '', i = 0, inStr = false;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += (n === undefined ? '' : n); i += 2; continue; }
      if (c === '"') inStr = false;
      i++; continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2; continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === '}' || src[j] === ']') { i++; continue; }
    }
    out += c; i++;
  }
  try {
    return JSON.parse(out);
  } catch (err) {
    // 把 JSON 的位置信息换算成行号，方便用户定位手写错误
    const m = /position (\d+)/.exec(err.message);
    if (m) {
      const pos = Number(m[1]);
      const line = out.slice(0, pos).split('\n').length;
      const near = out.split('\n')[line - 1] || '';
      throw new Error(`config.json 第 ${line} 行附近有 JSON 语法错误：${err.message}\n    该行内容：${near.trim().slice(0, 100)}`);
    }
    throw new Error('config.json JSON 语法错误：' + err.message);
  }
}

/* config.json 不存在时写入的最小默认配置（带注释的完整版由人工维护） */
const DEFAULT_CONFIG = {
  title: 'Markdown 文档浏览器',
  subtitle: '',
  home: { title: '文档索引', intro: '', showCards: true },
  sidebar: {
    title: '文档目录', defaultOpen: false, remember: true, showSearch: true,
    showCounts: true, folders: [], exclude: [], order: [], docs: {},
  },
  toc: { title: '本篇目录', defaultOpen: true, remember: true, maxDepth: 4 },
  reading: { maxWidth: 920 },
  markdown: { html: 'escape' },
  mindmap: {
    enabled: true, extensions: ['.mermaid'], initialExpandLevel: 2,
    showOutline: true, exportImage: true,
  },
  mermaid: {
    enabled: true, theme: 'auto', securityLevel: 'strict',
    controls: true, exportImage: true, fullscreen: true,
  },
};

async function readConfig({ createIfMissing = false } = {}) {
  let text;
  try {
    text = await fsp.readFile(CONFIG, 'utf8');
  } catch (err) {
    if (createIfMissing) {
      assertInsideRoot(CONFIG);
      await fsp.writeFile(CONFIG, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
      console.log('· 未找到 config.json，已生成一份默认配置：config.json');
    }
    return { value: DEFAULT_CONFIG, source: 'default' };
  }
  return { value: parseJsonc(text), source: 'file' };
}

/* 读取 vendor 下的引擎代码，准备整段内联进页面。
   cfg 里关掉的引擎不读文件，只登记成 disabled（页面里留空块）；
   need(ctx) 返回 false 的引擎登记成 skipped（离线版不内联，实时版照旧外链）。 */
async function readBundles(cfg, ctx = {}) {
  const out = [];
  for (const b of BUNDLES) {
    const enabled = typeof b.on === 'function' ? !!b.on(cfg) : true;
    const needed = enabled && (typeof b.need === 'function' ? !!b.need(ctx) : true);
    if (!enabled) {
      out.push({ id: b.id, file: b.file, dir: b.dir, role: b.role, disabled: true, skipped: false, text: '' });
      continue;
    }
    if (!needed) {
      out.push({ id: b.id, file: b.file, dir: b.dir, role: b.role, disabled: false, skipped: true, text: '' });
      continue;
    }
    const file = path.join(b.dir, b.file);
    let text;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch (e) {
      throw new Error(`缺少页面引擎文件：${path.relative(ROOT, file)}\n` +
        `  请从 vendor/${path.basename(b.dir)}/README.md 里按说明取回` +
        '（或把 config.json 里对应的功能关掉）。');
    }
    if (/<\/script/i.test(text)) {
      throw new Error(`${path.relative(ROOT, file)} 内含 "</script"，无法安全内联`);
    }
    out.push({ id: b.id, file: b.file, dir: b.dir, role: b.role, disabled: false, skipped: false, text });
  }
  return out;
}

/* ---------- 版本信息：根目录 VERSION = package.json 的 version + 提交标记 ----------
   VERSION 由 --stamp-version 写（正常是 pre-commit 钩子去调），构建只读它，
   把这一行拆成 { version, commit } 填进产物的 build-info 占位块，页面「关于」直接显示。
   读不到就退回 package.json 的 version、提交标记记为 nogit（从压缩包解压出来的工程没有 .git）。 */
function readPkg() {
  try { return JSON.parse(fs.readFileSync(PKG, 'utf8')); } catch (e) { return {}; }
}
function gitShortHead() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) { return ''; }
}
function readBuildInfo() {
  const pkg = readPkg();
  const raw = fs.existsSync(VERSION_FILE) ? fs.readFileSync(VERSION_FILE, 'utf8').trim() : '';
  const stamped = /^([^+\s]+)\+(\S+)$/.exec(raw);
  return {
    product: pkg.name || 'markdown-docs-helper',
    version: stamped ? stamped[1] : (pkg.version || '0.0.0'),
    commit: stamped ? stamped[2] : 'nogit',
    source: stamped ? 'VERSION' : 'package.json',
  };
}

/* 提交前把版本串刷进 VERSION。
   pre-commit 时新提交的哈希还不存在，所以记的是当下 HEAD（也就是这次提交的父提交）：
   产物里显示的提交标记天生落后一次提交，这是钩子机制决定的，不是笔误。 */
function stampVersion() {
  const pkg = readPkg();
  if (!pkg.version) {
    console.error('✗ package.json 里没有 version 字段，没法生成 VERSION');
    return 1;
  }
  const next = `${pkg.version}+${gitShortHead() || 'nogit'}\n`;
  const cur = fs.existsSync(VERSION_FILE) ? fs.readFileSync(VERSION_FILE, 'utf8') : '';
  /* 只比内容：autocrlf 会把检出的文件换成 CRLF，逐字节比会让钩子每次提交都重写一遍没变的东西 */
  if (cur.trim() === next.trim()) {
    console.log(`· VERSION 无需变化：${next.trim()}`);
    return 0;
  }
  fs.writeFileSync(VERSION_FILE, next, 'utf8');
  console.log(cur.trim() ? `✓ VERSION：${cur.trim()} → ${next.trim()}` : `✓ VERSION 已生成：${next.trim()}`);
  return 0;
}

const HOOK_MARK = 'build-docs.mjs --stamp-version';
const HOOK_BODY = [
  '#!/bin/sh',
  '# 提交前刷新 VERSION（package.json 的 version + 提交标记），并把改动一起纳入本次提交。',
  '# 本文件由 node build-docs.mjs --install-hook 生成；删掉它就退回手工维护 VERSION。',
  'node build-docs.mjs --stamp-version || exit 1',
  'git add VERSION',
  '',
].join('\n');
/* 只装这一个 pre-commit 文件，不碰 core.hooksPath：
   后者会换掉整个钩子目录，把仓库里已有的 post-commit / post-checkout 一并顶掉。 */
function installHook() {
  const hooks = path.join(ROOT, '.git', 'hooks');
  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    console.error(`✗ 这里不是 git 仓库（找不到 .git）：${ROOT}`);
    return 1;
  }
  if (!fs.existsSync(hooks)) fs.mkdirSync(hooks, { recursive: true });
  const target = path.join(hooks, 'pre-commit');
  if (fs.existsSync(target) && !fs.readFileSync(target, 'utf8').includes(HOOK_MARK)) {
    console.error(`✗ 已有一个不是本工具生成的 pre-commit 钩子：${target}`);
    console.error('  自己把这两行加进去即可：node build-docs.mjs --stamp-version && git add VERSION');
    return 1;
  }
  fs.writeFileSync(target, HOOK_BODY, { encoding: 'utf8', mode: 0o755 });
  fs.chmodSync(target, 0o755);
  console.log(`✓ 已安装 pre-commit 钩子：${target}`);
  console.log('  下一次提交起 VERSION 自动更新（钩子只存在于 .git 里，换机器要再跑一次 --install-hook）');
  return 0;
}

/* ---------- 两个页面的生成：模板 → 一次性替换 → md-viewer.html / index.html ----------
   模板 page.template.html 里只有八个空占位，其余全是纯 HTML，一眼能看懂：
     <script id="viewer-config" type="application/json"></script>   页面配置
     <script id="docs-snapshot" type="application/json"></script>   文档快照
     <script id="build-info" type="application/json"></script>      版本串（两个产物同一份）
     <script id="help-docs" type="application/json"></script>       帮助页正文（读 help/*.md）
     <script id="vendor-*"></script>                                引擎空块（4 段）
   两个产物的差别**只有**这些占位，所以用同一个替换函数、同一份文档数据生成，
   不存在“先写一个文件再回头改另一个”的二次加工。 */
function renderPage(template, { cfgText, snapText, buildInfoText, helpText, bundles, mode }) {
  const value = (id) => {
    if (id === 'viewer-config') return cfgText;
    if (id === 'build-info') return buildInfoText;
    if (id === 'help-docs') return helpText;
    if (id === 'docs-snapshot') return mode === 'realtime' ? '{}' : snapText;
    const b = bundles.find((x) => x.id === id);
    if (!b) throw new Error(`模板里出现了未知脚本块：${id}`);
    if (b.disabled || (b.skipped && mode !== 'realtime')) return '';   // 留空块
    /* 引擎占位：实时版整块换成指向本地文件的外链（返回 null 表示用外链标签），离线版把源码内联进来 */
    return mode === 'realtime' ? null : '\n' + b.text + '\n';
  };
  /* 一次性扫描所有占位块，按出现顺序拼接，避免「替换完再去重新定位下一个」那种脆弱写法。
     每个块都替换成完整的 <script ...>...</script>，不留半截标签。 */
  const re = /<script id="(viewer-config|docs-snapshot|build-info|help-docs|vendor-d3|vendor-markmap-lib|vendor-markmap-view|vendor-mermaid)"([^>]*)>([\s\S]*?)<\/script>/g;
  let out = '', last = 0, seen = 0, m;
  while ((m = re.exec(template))) {
    const id = m[1];
    /* viewer-config / docs-snapshot / build-info / help-docs 不在 bundles 里，只有 vendor-* 才是引擎块 */
    const b = id.startsWith('vendor-') ? bundles.find((x) => x.id === id) : null;
    if (id.startsWith('vendor-') && !b) throw new Error(`模板里出现了未知脚本块：${id}`);
    const inner = value(id);
    let replacement;
    if (b && b.disabled) replacement = `<script id="${id}"${m[2]} data-disabled="1"></script>`;
    else if (b && b.skipped && mode !== 'realtime') replacement = `<script id="${id}"${m[2]} data-unused="1"></script>`;
    else if (inner === null) replacement = vendorTag(b);
    else replacement = `<script id="${id}"${m[2]}>${inner}</script>`;
    out += template.slice(last, m.index) + replacement;
    last = m.index + m[0].length;
    seen++;
  }
  out += template.slice(last);
  if (seen !== 4 + bundles.length) {
    throw new Error(`模板里的占位块数量不对：期望 ${4 + bundles.length} 个，实际 ${seen} 个`);
  }
  return out;
}

/* 页面里是否有指向互联网的资源引用（离线承诺的硬校验） */
function onlineRefs(html) {
  return [...html.matchAll(/(?:src|href)\s*=\s*["'](?:https?:)?\/\//gi)].map((m) => m[0]);
}

/* ---------- 构建 ----------
   mode 决定写盘范围，只有 'build' 会写文件：
     'build'（默认）—— 明确的构建命令：md-viewer.html、docs-index.json、index.html 一起刷新
     'check'        —— 只跟磁盘上的产物比对，一个字节都不写
     'serve'        —— 不写盘：把实时版页面文本返回给 serve()，由它在内存里响应 /index.html */
async function build(mode = 'build') {
  const check = mode === 'check';
  const quiet = mode === 'serve';
  const cfg = await readConfig({ createIfMissing: mode === 'build' });
  const { docs, skipped, files } = await collect({
    withText: true,
    kinds: { md: true, mindmap: mindmapExts(cfg.value) },
  });
  const snap = snapshotPayload(docs, skipped);
  const idx = indexPayload(docs, skipped);
  const cfgText = renderConfig(cfg.value);
  const buildInfo = readBuildInfo();
  const buildInfoText = renderConfig(buildInfo);
  const helpPages = await readHelpPages();
  const helpText = renderHelp(helpPages);
  const needMermaid = mermaidEnabled(cfg.value) && needsMermaidEngine(docs);
  const bundles = await readBundles(cfg.value, { needMermaid });
  const template = await fsp.readFile(TEMPLATE, 'utf8');
  const wantOffline = mode !== 'serve';   // 离线单文件（引擎内联）要不要拼：--serve 用不上
  /* 文档快照文本只有离线单文件用得上（实时版页面里那块恒为 {}）；--serve 就省掉这份拼接 */
  const snapText = wantOffline ? renderSnapshot(snap) : '';
  const realtime = renderPage(template, { cfgText, snapText, buildInfoText, helpText, bundles, mode: 'realtime' });
  const next = wantOffline
    ? renderPage(template, { cfgText, snapText, buildInfoText, helpText, bundles, mode: 'offline' })
    : null;

  if (check) {
    const viewerText = await fsp.readFile(VIEWER, 'utf8');
    const vm = SNAPSHOT_RE.exec(viewerText);
    const vc = CONFIG_RE.exec(viewerText);
    const bi = BUILD_INFO_RE.exec(viewerText);
    const snapStale = !vm || isStale(vm[2], snap);
    const idxStale = !fs.existsSync(INDEX) || isStale(await fsp.readFile(INDEX, 'utf8'), idx);
    const cfgStale = !vc || isConfigStale(vc[2], cfg.value);
    const infoStale = !bi || isConfigStale(bi[2], buildInfo);
    const embedded = BUNDLES.map((b) => {
      const bm = bundleRe(b.id).exec(viewerText);
      return bm ? bm[2].trim() : '';
    });
    const bundleStale = embedded.some((text, i) => text !== bundles[i].text.trim());    /* 真正的检验：产物应与「模板 + 当前数据」完全一致（generatedAt 除外）。
       模板被手改、引擎没跟上、占位块填错，都会在这里露出来，不需要另写一套结构校验规则。 */
    const viewerStale = pageSignature(viewerText) !== pageSignature(next);
    /* 新克隆的仓库还没构建过：index.html 存在才校验 */
    const realtimeStale = fs.existsSync(INDEX_HTML) &&
      pageSignature(await fsp.readFile(INDEX_HTML, 'utf8')) !== pageSignature(realtime);
    if (snapStale || cfgStale || idxStale || infoStale || bundleStale || viewerStale || realtimeStale) {
      const which = [
        snapStale && '页面内置文档快照',
        cfgStale && '页面内置配置',
        idxStale && 'docs-index.json',
        infoStale && `页面内置版本串（VERSION 现在是 ${buildInfo.version}+${buildInfo.commit}）`,
        bundleStale && '页面内置引擎（markmap / mermaid 源码）',
        viewerStale && 'md-viewer.html（与 page.template.html 不一致，或模板被手改过）',
        realtimeStale && 'index.html（实时版页面）',
      ].filter(Boolean);
      console.error('✗ 已过期：' + which.join('、'));
      console.error('  请运行：node build-docs.mjs');
      return 1;
    }
    console.log(`✓ 都是最新的（${docs.length} 篇文档，来自 ${path.relative(ROOT, DOCS_DIR) || '.'}，配置来自 config.json` +
      `，版本 ${buildInfo.version}+${buildInfo.commit}` +
      `${fs.existsSync(INDEX_HTML) ? '，index.html 实时版页面已同步' : '，index.html 尚未生成（跑 node build-docs.mjs 生成）'}）`);
    return 0;
  }

  // 离线承诺的硬校验：产物里不许出现指向互联网的资源引用
  const onlineRt = onlineRefs(realtime);
  if (onlineRt.length) throw new Error(`index.html 里出现了互联网资源引用：${onlineRt.join(' ')}`);
  if (next !== null) {
    const online = onlineRefs(next);
    if (online.length) throw new Error(`md-viewer.html 里出现了互联网资源引用：${online.join(' ')}`);
  }

  /* --serve 到这里就结束：实时版页面交给服务在内存里响应。
     md-viewer.html / docs-index.json 一概不写，所以 --serve 指定哪个目录，
     都不会顶掉最后一次构建命令留下的产物。 */
  if (mode === 'serve') return realtime;

  assertInsideRoot(VIEWER);
  assertInsideRoot(INDEX);
  assertInsideRoot(INDEX_HTML);
  await fsp.writeFile(VIEWER, next, 'utf8');
  await fsp.writeFile(INDEX, renderIndex(idx), 'utf8');
  // 实时版页面与离线版同源同数据，只是引擎走本地外链、快照置空
  await fsp.writeFile(INDEX_HTML, realtime, 'utf8');

  if (!quiet) {
    const sb = cfg.value.sidebar || {};
    const k = countKinds(docs);
    const visible = (sb.folders && sb.folders.length) ? '仅 config.json 列出的目录' : '全部目录';
    const hidden = Object.keys(sb.docs || {}).filter((key) => (sb.docs[key] || {}).hidden).length;
    const mm = (cfg.value.mindmap || {});
    const mgBundle = bundles.find((b) => b.role === 'mermaid');
    const mgCfg = (cfg.value.mermaid || {});
    console.log('✓ 已刷新文档快照与页面配置');
    console.log(`  文档目录：${DOCS_DIR}${DOCS_DIR === DEFAULT_DOCS_DIR ? '' : '（命令行指定）'}`);
    if (EXCLUDES.length) {
      console.log(`  排除路径：${EXCLUDES.join('、')}（--exclude，不参与扫描）`);
    }
    console.log(`  文档：${docs.length} 篇（markdown ${k.markdown} 篇${k.mindmap ? ` · 思维导图 ${k.mindmap} 篇` : ''}` +
      `，扫描 ${files} 个文件，忽略 ${skipped} 个不支持的文件）`);
    docs.forEach((d) => console.log(`    · ${d.path}  ${(d.size / 1024).toFixed(1)} KB  ${d.title}`));
    console.log(`  思维导图：${mm.enabled === false ? '已关闭（config.json mindmap.enabled = false）' :
      `启用 · 后缀 ${mindmapExts(cfg.value).join(' ')} · 引擎已内联 ${(bundles.reduce((n, b) => n + (b.text || '').length, 0) / 1024).toFixed(0)} KB`}`);
    const mgState = mgCfg.enabled === false
      ? '已关闭（config.json mermaid.enabled = false）· 围栏只当普通代码块'
      : mgBundle.skipped
        ? '启用，但这批文档里没有 Mermaid 图表 · 离线单文件不内联引擎（实时版仍本地外链）'
        : `启用 · \`\`\`mermaid 围栏与 .mermaid 图表文档都会画成图 · 引擎已内联 ${(mgBundle.text.length / 1024).toFixed(0)} KB（实时版本地外链）`;
    console.log(`  嵌入 Mermaid 图表：${mgState}`);
    console.log(`  左栏显示规则：${visible}` +
      ((sb.exclude || []).length ? ` · 排除 ${(sb.exclude || []).length} 项` : '') +
      (hidden ? ` · 隐藏 ${hidden} 篇` : ''));
    console.log(`  配置来源：config.json（${cfg.source === 'file' ? '已读取' : '缺失，用默认值'}）`);
    console.log(`  帮助：${helpPages.length} 页（${path.relative(ROOT, HELP_DIR).split(path.sep).join('/')}）`);
    console.log(`  版本：${buildInfo.version}+${buildInfo.commit}` +
      (buildInfo.source === 'VERSION' ? '（VERSION）'
        : '（VERSION 缺失或格式不对，退回 package.json；生成它：node build-docs.mjs --stamp-version）'));
    console.log(`  离线单文件：${Buffer.byteLength(next, 'utf8') / 1024 | 0} KB` +
      `（文档数据 ${Buffer.byteLength(snapText, 'utf8') / 1024 | 0} KB · 内联引擎 ${bundles.reduce((n, b) => n + (b.text || '').length, 0) / 1024 | 0} KB）`);
    console.log('');
    console.log('  直接双击打开：md-viewer.html');
    console.log('  实时浏览（文档/配置改动无需重建）：node build-docs.mjs --serve');
    console.log('  局域网共享（绑定所有网卡）：node build-docs.mjs --serve --lan');
  }
  return 0;
}

/* ---------- 本地静态服务（实时模式） ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mermaid': 'text/plain; charset=utf-8',
  '.mmd': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

/** 把 target 限制在 base 内，返回是否安全 */
function isInside(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/* ---------- 监听地址：默认只听环回，--lan / --host 才对外 ---------- */

/** URL 里的主机名：IPv6 字面量要加方括号（http://[::1]:8899/） */
function hostForUrl(host) { return host.includes(':') ? `[${host}]` : host; }

/** 是不是「只有本机能连」的地址（用来决定提示语和是否补印局域网地址） */
function isLoopbackHost(host) {
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

/** 绑定 0.0.0.0 / :: 时，列出本机各网卡的 IPv4，供使用者直接抄给同事 */
function lanAddresses() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.internal || a.family !== 'IPv4') continue;
      out.push(a.address);
    }
  }
  return [...new Set(out)];
}

/** 解析 --host 的值：IP 字面量（v4/v6，允许 [::1] 写法）或主机名，其它一律拒绝 */
function normalizeHost(value) {
  const s = String(value).trim();
  if (!s) return null;
  if (net.isIP(s)) return s;
  if (s.length > 2 && s.startsWith('[') && s.endsWith(']') && net.isIP(s.slice(1, -1))) return s.slice(1, -1);
  return /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(s) ? s : null;
}

/* EACCES 有两种完全不同的来头，别混为一谈：
     · 1024 以下的特权端口 —— Linux/macOS 上要 root/sudo，Windows 上这类端口
       还常被系统组件（IIS/http.sys）先占着；
     · 端口被别的程序独占监听 —— Windows 上第二次 bind 拿到的就是 EACCES
       （WSAEACCES 10013），EADDRINUSE 反而见不到；Hyper-V/WSL/Docker 预留的
       端口段也报 EACCES。实测：mosquitto 占着 0.0.0.0:9001 时，
       node 绑 127.0.0.1:9001 报的就是 EACCES，与「小于 1024」毫无关系。 */
const EACCES_DETAIL = 'Windows 上端口被别的程序独占监听、' +
  '或落在 Hyper-V/WSL/Docker 预留的端口段里，报的都是 EACCES';

function eaccesReason(port) {
  if (port < 1024) {
    return `端口 ${port} 小于 1024，绑定特权端口要管理员权限` +
      `（Linux/macOS 用 sudo，Windows 用管理员身份的终端）；` +
      `Windows 上这类端口还常被系统组件（IIS/http.sys）独占，换 1024 以上的端口最省事`;
  }
  return `端口 ${port} 被别人占着或用不了：${EACCES_DETAIL}`;
}

/** 端口用不了时，怎么自己查清楚 */
function portOwnerHint(port) {
  return `查占用：netstat -ano | findstr :${port}（看 PID），` +
    `查系统预留：netsh interface ipv4 show excludedportrange protocol=tcp`;
}

/** 把 bind 失败翻译成能照着改的提示 */
function bindError(err, host, port) {
  const tip = {
    EADDRNOTAVAIL: `本机没有这个地址：${host}（用 ipconfig / ifconfig 看一眼本机 IP，或直接用 --lan 绑定所有网卡）`,
    ENOTFOUND: `解析不了这个主机名：${host}`,
    EACCES: `没有权限绑定 ${host}：${eaccesReason(port)}（${portOwnerHint(port)}）`,
    EAFNOSUPPORT: `本机不支持这种地址：${host}`,
  }[err.code];
  const e = new Error(tip || `无法绑定 ${host}：${err.message}`);
  e.cause = err;
  return e;
}

/* realtimeHtml：build('serve') 现算的实时版页面。--serve 全程不落盘，页面就在内存里给出去。 */
async function serve(port, kinds, host = DEFAULT_HOST, realtimeHtml) {
  const server = http.createServer(async (req, res) => {
    const send = (code, type, body) => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    };
    const sendFile = (target) => {
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(target).pipe(res);
    };
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const pathname = decodeURIComponent(url.pathname);

      // 默认入口是实时版 index.html（引擎走本地外链，比离线版轻很多）
      if (pathname === '/') {
        res.writeHead(302, { Location: '/index.html' });
        return res.end();
      }
      if (pathname === '/index.html') return send(200, MIME['.html'], realtimeHtml);
      // md-viewer.html 等其它工程内文件走下面的通用静态分支
      // 实时索引：每次请求都重新扫描文档目录，因此新增文档无需重建
      if (pathname === '/docs-index.json') {
        const { docs, skipped } = await collect({ withText: false, kinds });
        return send(200, MIME['.json'], renderIndex(indexPayload(docs, skipped)));
      }
      // 页面已内置 data: 图标，这里再兜一层，避免控制台出现无谓的 404
      if (pathname === '/favicon.ico') {
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        return res.end();
      }
      // 文档正文：真实位置可能在工程之外（命令行指定了别的目录），单独映射到 /docs/**
      if (pathname === '/' + VIRTUAL_ROOT || pathname.startsWith('/' + VIRTUAL_ROOT + '/')) {
        const rel = pathname.slice(('/' + VIRTUAL_ROOT).length).replace(/^\/+/, '');
        const target = path.resolve(DOCS_DIR, rel);
        if (!isInside(DOCS_DIR, target)) return send(403, MIME['.txt'], 'Forbidden');
        const st = await fsp.stat(target).catch(() => null);
        if (!st || st.isDirectory()) return send(404, MIME['.txt'], 'Not Found');
        return sendFile(target);
      }

      const target = path.resolve(ROOT, '.' + pathname);
      if (!isInside(ROOT, target)) return send(403, MIME['.txt'], 'Forbidden');
      const st = await fsp.stat(target).catch(() => null);
      if (!st || st.isDirectory()) return send(404, MIME['.txt'], 'Not Found');
      sendFile(target);
    } catch (err) {
      send(500, MIME['.txt'], 'Server Error: ' + err.message);
    }
  });

  /* 端口用不了就从 port+1 顺延，最多试 10 个。
     「用不了」有两种：EADDRINUSE 是常规的「端口被占用」；Windows 上端口被别的
     程序独占监听时拿到的是 EACCES，同样属于「这个端口用不了」，所以一并顺延。
     只顺延 1024 以上的端口：再往下走全是特权端口，权限/系统占用的问题换 +1
     也解决不了，那种情况直接报错并把原因说清楚（用户写的是明确的端口号）。
     绑定地址坏了（EADDRNOTAVAIL 等）换端口同样救不了，直接报错。 */
  const MAX_TRIES = 10;
  const TRIES_TOTAL = MAX_TRIES + 1;
  const occupied = (err, p) => (err.code === 'EADDRINUSE' || err.code === 'EACCES') && p >= 1024;
  let warned = false;
  const listen = (p, tries) => new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (!occupied(err, p)) return reject(bindError(err, host, p));
      if (tries === 0) {
        return reject(new Error(
          `从端口 ${port} 起连续 ${TRIES_TOTAL} 个端口都绑不上（被别的程序占用、或系统保留），` +
          `用 --port 换一个空闲端口；${portOwnerHint(port)}`));
      }
      if (!warned) {
        warned = true;
        console.log(`! 端口 ${p} 绑不上（${err.code}），自动往后找端口` +
          (err.code === 'EACCES' ? `：${EACCES_DETAIL}` : ''));
      }
      resolve(listen(p + 1, tries - 1));
    });
    server.listen(p, host, () => resolve(p));
  });

  const actual = await listen(port, MAX_TRIES);

  /* 该印哪些访问地址：绑定具体地址就只印它；绑到 0.0.0.0/:: 就把环回与各网卡都印出来 */
  const wildcard = host === LAN_HOST || host === '::';
  const entries = [];
  const add = (h, label) => {
    const url = `http://${hostForUrl(h)}:${actual}/`;
    if (!entries.some((e) => e.url === url)) entries.push({ url, label });
  };
  if (wildcard) {
    add('127.0.0.1', '本机访问');
    if (host === '::') add('::1', '本机访问');
    lanAddresses().forEach((ip) => add(ip, '局域网访问'));
  } else {
    add(host, isLoopbackHost(host) ? '本机访问' : '指定地址访问');
  }

  const width = Math.max(...entries.map((e) => e.url.length));
  console.log('✓ 文档服务已启动（实时模式：修改文档后刷新页面即生效）');
  console.log(`  文档目录：${DOCS_DIR}${DOCS_DIR === DEFAULT_DOCS_DIR ? '' : '（命令行指定）'}`);
  if (EXCLUDES.length) {
    console.log(`  排除路径：${EXCLUDES.join('、')}（--exclude，不参与扫描）`);
  }
  console.log(`  监听地址：${hostForUrl(host)}:${actual}` +
    (wildcard ? `（所有网卡，同一网络内的其它机器可以访问）` :
      isLoopbackHost(host) ? `（仅本机）` : `（指定地址）`));
  entries.forEach((e) => {
    const tail = e.url === entries[0].url ? '  ← 实时版 index.html（引擎走本地外链）' : '';
    console.log(`  ${e.label}：${e.url.padEnd(width)}${tail}`);
  });
  if (fs.existsSync(VIEWER)) {
    console.log(`  离线版对照：${entries[0].url}${path.basename(VIEWER)}`);
  } else {
    console.log('  离线版未生成（--serve 不写产物）：node build-docs.mjs');
  }
  if (wildcard) {
    console.log('  提示：服务没有鉴权，文档内容对同一网络可见，只在可信内网里这么用。');
  } else if (isLoopbackHost(host)) {
    console.log('  想让同一局域网的同事也能看：node build-docs.mjs --serve --lan');
  } else {
    console.log('  提示：服务没有鉴权，文档内容对能连到这个地址的人可见，只在可信内网里这么用。');
  }
  console.log('  按 Ctrl+C 停止。');
  return actual;
}

/* ---------- CLI ----------
   参数解析刻意严格：只认下面这些写法，多一个未知参数、多一个目录、坏的端口号、
   坏的监听地址都直接报错退出。以前那种“写了但被忽略”的情况不会再出现。 */
const argv = process.argv.slice(2);

function printHelp() {
  const header = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  const out = [];
  for (let i = 1; i < header.length; i++) {
    if (header[i].trim().endsWith('*/')) break;   // 注释块结束
    out.push(header[i].replace(/^\s*\/?\*+ ?/, ''));
  }
  console.log(out.join('\n'));
  process.exit(0);
}

function cliError(msg) {
  console.error('✗ ' + msg);
  console.error('  运行 node build-docs.mjs --help 查看用法。');
  process.exit(1);
}

const MODE_FLAGS = new Map([['--serve', 'serve'], ['--check', 'check']]);
/* 两个「只干这一件事」的命令：都不跑构建，所以和模式/端口/目录互斥 */
const ACTION_FLAGS = new Set(['--stamp-version', '--install-hook']);
let mode = 'build';           // build | check | serve
let action = null;            // --stamp-version | --install-hook
let port = DEFAULT_PORT;
let portGiven = false;
let host = DEFAULT_HOST;      // 监听地址：默认只听环回
let hostFlag = null;          // 记下是用 --host 还是 --lan 指定的（重复/混用要报错）
let docsDir = null;           // 命令行指定的文档目录（最多一个）

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];

  if (a === '--help' || a === '-h') {
    printHelp();
  } else if (ACTION_FLAGS.has(a)) {
    if (action) cliError(`${a} 与 ${action} 只能选一个`);
    if (mode !== 'build') cliError(`${a} 是独立命令，不与 --${mode} 一起用`);
    action = a;
  } else if (MODE_FLAGS.has(a)) {
    if (action) cliError(`${a} 与 ${action} 只能选一个`);
    if (mode !== 'build') {
      cliError(`--serve 与 --check 只能选一个（已经写了 --${mode}，又出现 ${a}）`);
    }
    mode = MODE_FLAGS.get(a);
  } else if (a === '--port') {
    const v = argv[i + 1];
    if (portGiven) cliError('--port 写了两次，只允许一个端口号');
    if (v === undefined || v.startsWith('-')) {
      cliError('--port 后面要跟端口号，例如：node build-docs.mjs --serve --port 9000');
    }
    if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 65535) {
      cliError(`--port 只接受 1-65535 的整数端口号，收到：${v}`);
    }
    port = Number(v);
    portGiven = true;
    i++;
  } else if (a === '--host') {
    const v = argv[i + 1];
    if (hostFlag) cliError(`${a} 与 ${hostFlag} 只能选一个（监听地址已经用 ${hostFlag} 指定过了）`);
    if (v === undefined || v.startsWith('-')) {
      cliError('--host 后面要跟监听地址，例如：node build-docs.mjs --serve --host 0.0.0.0');
    }
    const parsed = normalizeHost(v);
    if (!parsed) {
      if (v.includes('://') || /:\d+$/.test(v) || v.includes('/')) {
        cliError(`--host 只写地址本身，端口用 --port 指定（收到：${v}）`);
      }
      cliError(`--host 只接受 IP 或主机名（如 0.0.0.0、::、192.168.1.20、localhost），收到：${v}`);
    }
    host = parsed;
    hostFlag = '--host';
    i++;
  } else if (a === '--lan') {
    if (hostFlag) cliError(`${a} 与 ${hostFlag} 只能选一个（监听地址已经用 ${hostFlag} 指定过了）`);
    host = LAN_HOST;
    hostFlag = '--lan';
  } else if (a === '--exclude') {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('-')) {
      cliError('--exclude 后面要跟相对文档目录的路径，例如：node build-docs.mjs --exclude a/b --serve ./');
    }
    const norm = normalizeExclude(v);
    if (!EXCLUDES.includes(norm)) EXCLUDES.push(norm);
    i++;
  } else if (a === '--docs') {
    cliError('--docs 已取消：目录直接写在参数后面即可，例如：node build-docs.mjs --serve D:\\some\\docs');
  } else if (a.startsWith('-') && a !== '-') {
    cliError(`未知参数：${a}`);
  } else if (a === '-') {
    cliError('“-” 不是有效目录');
  } else {
    if (docsDir !== null) cliError(`只能指定一个文档目录，多出来的是：${a}`);
    docsDir = path.resolve(a);
  }
}

if (portGiven && mode !== 'serve') {
  cliError('--port 只在 --serve 模式下有效，例如：node build-docs.mjs --serve --port 9000');
}
if (hostFlag && mode !== 'serve') {
  cliError(`${hostFlag} 只在 --serve 模式下有效，例如：node build-docs.mjs --serve --lan`);
}

if (action && docsDir !== null) {
  cliError(`${action} 不接受文档目录参数：${docsDir}`);
}
if (action && EXCLUDES.length) {
  cliError(`${action} 不接受 --exclude 参数`);
}

if (action === '--stamp-version') {
  process.exit(stampVersion());
}
if (action === '--install-hook') {
  process.exit(installHook());
}

if (docsDir !== null) {
  const st = fs.statSync(docsDir, { throwIfNoEntry: false });
  if (!st) cliError(`文档目录不存在：${docsDir}`);
  if (!st.isDirectory()) cliError(`这不是一个目录：${docsDir}`);
  DOCS_DIR = docsDir;
}

try {
  if (mode === 'check') {
    process.exit(await build('check'));
  } else if (mode === 'serve') {
    // 实时版页面现算现给，不落盘；md-viewer.html / docs-index.json 只由构建命令刷新
    const realtimeHtml = await build('serve');
    const cfg = await readConfig();
    if (cfg.source !== 'file') {
      console.log('· 未找到 config.json，本次按默认配置服务（--serve 不写文件）：');
      console.log('  想要一份可编辑的配置：node build-docs.mjs');
    }
    await serve(port, { md: true, mindmap: mindmapExts(cfg.value) }, host, realtimeHtml);
  } else {
    process.exit(await build());
  }
} catch (err) {
  console.error('✗ ' + (err && err.message ? err.message : err));
  process.exit(1);
}
