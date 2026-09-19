#!/usr/bin/env node
/* =====================================================================
 * markdown-docs-helper —— build-docs.mjs
 * 为 md-viewer.html 生成内置文档数据，或启动本地实时服务。
 *
 * 重要：本脚本【只读】文档目录，绝不修改、移动、删除任何 .md 文档。
 *       写入被限制在本工程内，且不允许写进文档目录（见 assertInsideRoot）：
 *         · md-viewer.html  —— 只替换其中两段 <script type="application/json">
 *         · docs-index.json  —— 实时模式的索引
 *         · config.json      —— 仅在缺失时生成默认配置
 *
 * 用法：
 *   node build-docs.mjs                       # 扫描 ./docs，刷新页面内置数据
 *   node build-docs.mjs <目录>                 # 扫描任意目录（页面内路径前缀仍为 docs/）
 *   node build-docs.mjs --check [目录]         # 只检查是否过期（过期退出码 1），不写文件
 *   node build-docs.mjs --serve [目录]         # 启动本地实时服务（默认 8899，占用则顺延）
 *   node build-docs.mjs --serve --port 9000 [目录]
 *   node build-docs.mjs --help
 *
 * 目录位置随意（写在参数前后都行），但最多只能写一个；不写就是工程自带的 ./docs。
 * 参数写错会直接报错退出，绝不会被静默忽略：未知参数、多余目录、坏的端口号都会拦下。
 *
 * 配置文件：config.json（标题、首页说明、左栏显示哪些文档、右侧目录层级等）。
 *           支持 // 与 /* *\/ 注释和尾随逗号；写错时页面会显示红色提示。
 *
 * 两种浏览方式：
 *   1) 直接双击 md-viewer.html（file://）——使用页面内置数据，零依赖、可离线；
 *      文档变动后重跑本脚本刷新。
 *   2) node build-docs.mjs --serve —— 页面改为实时读取文档目录下的 .md，
 *      新增/修改文档刷新页面即生效，无需重新构建。
 * ===================================================================== */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));   // 工程根
/* 页面里的文档路径前缀。固定为 docs/，与文档的真实位置无关：
   即使用命令行指定了别的目录，config.json 里的 folders/exclude/docs 也不用改。 */
const VIRTUAL_ROOT = 'docs';
const DEFAULT_DOCS_DIR = path.join(ROOT, 'docs');
let DOCS_DIR = DEFAULT_DOCS_DIR;
const VIEWER = path.join(ROOT, 'md-viewer.html');
const INDEX = path.join(ROOT, 'docs-index.json');
const CONFIG = path.join(ROOT, 'config.json');
const SNAPSHOT_RE = /(<script id="docs-snapshot" type="application\/json">)([\s\S]*?)(<\/script>)/;
const CONFIG_RE = /(<script id="viewer-config" type="application\/json">)([\s\S]*?)(<\/script>)/;
const DEFAULT_PORT = 8899;

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
async function walk(dir, base = '') {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
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

function sortDocs(docs) {
  const dirRank = (d) => (d.dir === '.' ? '' : d.dir);
  return docs.sort((a, b) =>
    dirRank(a).localeCompare(dirRank(b), 'zh-Hans-CN') ||
    a.path.localeCompare(b.path, 'zh-Hans-CN'));
}

/** 扫描并读取文档目录下所有 markdown（withText=false 时不带正文，供实时索引使用） */
async function collect({ withText = true } = {}) {
  if (!fs.existsSync(DOCS_DIR)) throw new Error(`找不到文档目录：${DOCS_DIR}`);
  const files = await walk(DOCS_DIR);
  const md = files.filter((f) => /\.md$/i.test(f.name));
  const skipped = files.length - md.length;
  const docs = [];
  for (const f of md) {
    const st = await fsp.stat(f.full);
    const vpath = `${VIRTUAL_ROOT}/${f.rel}`;
    const rec = {
      path: vpath,
      dir: path.posix.dirname(vpath),
      name: f.name,
      size: st.size,
      mtime: st.mtime.toISOString(),
      title: f.name.replace(/\.md$/i, ''),
    };
    const text = await fsp.readFile(f.full, 'utf8');
    rec.title = titleOf(text, rec.title);
    if (withText) rec.text = text;
    docs.push(rec);
  }
  return { docs: sortDocs(docs), skipped, files: files.length, md: md.length };
}

function snapshotPayload(docs, skipped) {
  return { generatedAt: new Date().toISOString(), docsRoot: VIRTUAL_ROOT + '/', count: docs.length, skipped, docs };
}

function indexPayload(docs, skipped) {
  return {
    generatedAt: new Date().toISOString(),
    docsRoot: VIRTUAL_ROOT + '/',
    count: docs.length,
    skipped,
    docs: docs.map((d) => ({
      path: d.path, dir: d.dir, name: d.name,
      title: d.title, size: d.size, mtime: d.mtime,
    })),
  };
}

/* "<" 转义为 \u003c，避免正文中出现 </script> 提前闭合脚本标签 */
function renderSnapshot(payload) { return JSON.stringify(payload).replace(/</g, '\\u003c'); }
function renderConfig(payload) { return JSON.stringify(payload).replace(/</g, '\\u003c'); }
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

/* ---------- 构建 ---------- */
async function build({ quiet = false, check = false } = {}) {
  const { docs, skipped, files } = await collect({ withText: true });
  const snap = snapshotPayload(docs, skipped);
  const idx = indexPayload(docs, skipped);
  const snapText = renderSnapshot(snap);
  const cfg = await readConfig({ createIfMissing: !check });
  const cfgText = renderConfig(cfg.value);
  const html = await fsp.readFile(VIEWER, 'utf8');
  const m = SNAPSHOT_RE.exec(html);
  if (!m) {
    throw new Error(`未在 ${path.basename(VIEWER)} 中找到 <script id="docs-snapshot"> 数据块`);
  }
  const cm = CONFIG_RE.exec(html);
  if (!cm) {
    throw new Error(`未在 ${path.basename(VIEWER)} 中找到 <script id="viewer-config"> 数据块`);
  }
  // 快照块位置靠后，先替换它，再重新定位配置块
  let next = html.slice(0, m.index) + m[1] + snapText + m[3] + html.slice(m.index + m[0].length);
  const cm2 = CONFIG_RE.exec(next);
  next = next.slice(0, cm2.index) + cm2[1] + cfgText + cm2[3] + next.slice(cm2.index + cm2[0].length);

  if (check) {
    const snapStale = isStale(m[2], snap);
    const idxStale = !fs.existsSync(INDEX) || isStale(await fsp.readFile(INDEX, 'utf8'), idx);
    const cfgStale = isConfigStale(cm[2], cfg.value);
    if (snapStale || cfgStale || idxStale) {
      const which = [snapStale && '页面内置文档快照', cfgStale && '页面内置配置', idxStale && 'docs-index.json'].filter(Boolean);
      console.error('✗ 已过期：' + which.join('、'));
      console.error('  请运行：node build-docs.mjs');
      return 1;
    }
    console.log(`✓ 都是最新的（${docs.length} 篇文档，来自 ${path.relative(ROOT, DOCS_DIR) || '.'}，配置来自 config.json）`);
    return 0;
  }

  assertInsideRoot(VIEWER);
  assertInsideRoot(INDEX);
  await fsp.writeFile(VIEWER, next, 'utf8');
  await fsp.writeFile(INDEX, renderIndex(idx), 'utf8');

  if (!quiet) {
    const sb = cfg.value.sidebar || {};
    const visible = (sb.folders && sb.folders.length) ? '仅 config.json 列出的目录' : '全部目录';
    const hidden = Object.keys(sb.docs || {}).filter((k) => (sb.docs[k] || {}).hidden).length;
    console.log('✓ 已刷新文档快照与页面配置');
    console.log(`  文档目录：${DOCS_DIR}${DOCS_DIR === DEFAULT_DOCS_DIR ? '' : '（命令行指定）'}`);
    console.log(`  文档：${docs.length} 篇 markdown（扫描 ${files} 个文件，忽略 ${skipped} 个非 md 文件）`);
    docs.forEach((d) => console.log(`    · ${d.path}  ${(d.size / 1024).toFixed(1)} KB  ${d.title}`));
    console.log(`  左栏显示规则：${visible}` +
      ((sb.exclude || []).length ? ` · 排除 ${(sb.exclude || []).length} 项` : '') +
      (hidden ? ` · 隐藏 ${hidden} 篇` : ''));
    console.log(`  配置来源：config.json（${cfg.source === 'file' ? '已读取' : '缺失，用默认值'}）`);
    console.log(`  内置快照：${Buffer.byteLength(next, 'utf8') / 1024 | 0} KB（其中文档数据 ${Buffer.byteLength(snapText, 'utf8') / 1024 | 0} KB）`);
    console.log('');
    console.log('  直接双击打开：md-viewer.html');
    console.log('  实时浏览（文档/配置改动无需重建）：node build-docs.mjs --serve');
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

async function serve(port) {
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

      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(302, { Location: '/' + path.basename(VIEWER) });
        return res.end();
      }
      // 实时索引：每次请求都重新扫描文档目录，因此新增文档无需重建
      if (pathname === '/docs-index.json') {
        const { docs, skipped } = await collect({ withText: false });
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

  const listen = (p, tries) => new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && tries > 0) resolve(listen(p + 1, tries - 1));
      else reject(err);
    });
    server.listen(p, '127.0.0.1', () => resolve(p));
  });

  const actual = await listen(port, 10);
  console.log('✓ 文档服务已启动（实时模式：修改文档后刷新页面即生效）');
  console.log(`  文档目录：${DOCS_DIR}${DOCS_DIR === DEFAULT_DOCS_DIR ? '' : '（命令行指定）'}`);
  console.log(`  本机访问：http://127.0.0.1:${actual}/`);
  console.log('  按 Ctrl+C 停止。');
  return actual;
}

/* ---------- CLI ----------
   参数解析刻意严格：只认下面这些写法，多一个未知参数、多一个目录、坏的端口号
   都直接报错退出。以前那种“写了但被忽略”的情况不会再出现。 */
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
let mode = 'build';           // build | check | serve
let port = DEFAULT_PORT;
let portGiven = false;
let docsDir = null;           // 命令行指定的文档目录（最多一个）

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];

  if (a === '--help' || a === '-h') {
    printHelp();
  } else if (MODE_FLAGS.has(a)) {
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

if (docsDir !== null) {
  const st = fs.statSync(docsDir, { throwIfNoEntry: false });
  if (!st) cliError(`文档目录不存在：${docsDir}`);
  if (!st.isDirectory()) cliError(`这不是一个目录：${docsDir}`);
  DOCS_DIR = docsDir;
}

try {
  if (mode === 'check') {
    process.exit(await build({ check: true }));
  } else if (mode === 'serve') {
    await build({ quiet: true });
    await serve(port);
  } else {
    process.exit(await build());
  }
} catch (err) {
  console.error('✗ ' + (err && err.message ? err.message : err));
  process.exit(1);
}
