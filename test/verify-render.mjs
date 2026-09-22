/* =====================================================================
 * 渲染器回归测试（纯 Node，不需要浏览器）
 *
 * 做法：把 assets/md-core.js（渲染器源码，页面用 <script src> 外链它）读进来 require，
 *       用它渲染 docs/ 与 test/fixtures/ 下的全部 markdown，然后与
 *       「独立写的源码扫描器」交叉验证：
 *         · 标题数 / 表格数 / 围栏数 / 分隔线数与源码一致
 *         · 标签开闭配对、无残留 Markdown 标记、标题 id 不重复
 *         · 每个表格逐格比对（源码单元格 vs 渲染结果，不丢格不串列）
 *         · 若干专项断言（缩进代码块、嵌套列表、交叉引用、转义、CJK 折行）
 *
 * 用法：node test/verify-render.mjs      （失败退出码 1）
 * ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ASSETS = path.join(ROOT, 'assets');

/* 渲染器与应用逻辑的源码在 assets/ 下（页面用 <script src> 外链），这里直接读文件 */
function readAsset(name) {
  const p = path.join(ASSETS, name);
  if (!fs.existsSync(p)) throw new Error('未找到 ' + path.relative(ROOT, p));
  return fs.readFileSync(p, 'utf8');
}

/* 源码同时留一份到 test/.cache/ 便于排查 */
const CACHE = path.join(HERE, '.cache');
fs.mkdirSync(CACHE, { recursive: true });
fs.writeFileSync(path.join(CACHE, 'md-core.cjs'), readAsset('md-core.js'));
fs.writeFileSync(path.join(CACHE, 'md-app.js'), readAsset('md-app.js'));

const require = createRequire(import.meta.url);
const Core = require(path.join(CACHE, 'md-core.cjs'));

/* ---------- 收集被测文档：docs/（真实内容）+ test/fixtures/（渲染陷阱） ---------- */
const SOURCES = [
  { dir: path.join(ROOT, 'docs'), prefix: 'docs' },
  { dir: path.join(HERE, 'fixtures'), prefix: 'docs/fixtures' },
];
const docs = [];
for (const src of SOURCES) {
  if (!fs.existsSync(src.dir)) continue;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.md$/i.test(e.name)) {
        const rel = path.relative(src.dir, p).split(path.sep).join('/');
        docs.push({ path: src.prefix + '/' + rel, text: fs.readFileSync(p, 'utf8') });
      }
    }
  })(src.dir);
}
docs.sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'));
if (!docs.length) { console.log('x 没有找到任何 markdown 文档'); process.exit(1); }
console.log(`被测文档 ${docs.length} 篇（docs/ 与 test/fixtures/）\n`);

const byPath = {}, byBase = {};
for (const d of docs) { byPath[d.path] = d; byBase[path.posix.basename(d.path)] = d; }

/* 每篇文档的「标题编号 -> 锚点 id」表，供跨文档章节引用（父文档 §4.1）使用 */
const sectionMaps = {};
for (const d of docs) {
  const m = {};
  for (const h of Core.scanHeadings(d.text)) if (h.num && !(h.num in m)) m[h.num] = h.id;
  sectionMaps[d.path] = m;
}

function makeCtx(docPath) {
  return {
    docPath,
    docHref: (p, s) => '#p=' + encodeURIComponent(p) + (s ? '&h=' + encodeURIComponent(s) : ''),
    resolveDoc: (ref) => {
      if (!ref) return null;
      let section = null;
      const h = ref.indexOf('#');
      if (h >= 0) { section = ref.slice(h + 1); ref = ref.slice(0, h); }
      ref = ref.trim().replace(/^\.\//, '').replace(/^\/+/, '');
      if (!/\.md$/i.test(ref)) return null;
      if (byPath[ref]) return { path: ref, section };
      const b = path.posix.basename(ref);
      if (byBase[b]) return { path: byBase[b].path, section };
      return null;
    },
    sectionsOf: (p) => sectionMaps[p] || null,
    resolveAsset: (p) => p,
  };
}

/* ---------- 独立扫描源码（不复用渲染器逻辑，作为交叉验证） ---------- */
function scanSource(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const r = { headings: 0, tables: 0, fences: 0, hr: 0 };
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const fm = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(L);
    if (fm) {
      const ch = fm[1][0];
      if (!fence) { fence = ch; r.fences++; }
      else if (ch === fence) fence = null;
      continue;
    }
    if (fence) continue;
    if (/^ {0,3}(#{1,6})[ \t]+/.test(L)) { r.headings++; continue; }
    const nxt = lines[i + 1] || '';
    if (L.includes('|') && /^[|\s:-]+$/.test(nxt.trim()) && /-/.test(nxt) && nxt.includes('|')) { r.tables++; i++; continue; }
    if (/^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/.test(L)) r.hr++;
  }
  return r;
}

let fail = 0;
const bad = (m) => { console.log('  x ' + m); fail++; };

for (const d of docs) {
  const src = scanSource(d.text);
  const out = Core.render(d.text, makeCtx(d.path));
  const h = out.html;
  const name = d.path;
  const issues = [];

  if (out.headings.length !== src.headings) issues.push(`标题数 渲染=${out.headings.length} 源码=${src.headings}`);
  const tables = (h.match(/<table>/g) || []).length;
  if (tables !== src.tables) issues.push(`表格数 渲染=${tables} 源码=${src.tables}`);

  const noCode = h.replace(/<pre class="code">[\s\S]*?<\/pre>/g, '').replace(/<code>[\s\S]*?<\/code>/g, '');
  const leftovers = (noCode.match(/\*\*|~~|^\s*\|/gm) || []).length;
  if (leftovers) issues.push(`残留标记 ${leftovers} 处`);

  for (const tag of ['p', 'li', 'ul', 'ol', 'td', 'th', 'tr', 'table', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'strong', 'em', 'del']) {
    const o = (h.match(new RegExp('<' + tag + '[ >]', 'g')) || []).length;
    const c = (h.match(new RegExp('</' + tag + '>', 'g')) || []).length;
    if (o !== c) issues.push(`标签 <${tag}> 开=${o} 闭=${c}`);
  }
  if (/<script/i.test(h)) issues.push('输出中出现 <script');
  const ids = out.headings.map((x) => x.id);
  if (new Set(ids).size !== ids.length) issues.push('标题 id 重复');
  for (const id of ids) if (!h.includes('id="' + id + '"')) issues.push('缺少标题 id: ' + id);

  console.log(`${issues.length ? 'x' : 'v'} ${name}  标题${out.headings.length} 表${tables} 行${(h.match(/<tr>/g) || []).length} th${(h.match(/<th/g) || []).length} td${(h.match(/<td/g) || []).length} pre${(h.match(/<pre class="code">/g) || []).length}(围栏${src.fences}) hr${(h.match(/<hr>/g) || []).length}/${src.hr} secref${(h.match(/class="secref"/g) || []).length} docref${(h.match(/class="docref"/g) || []).length}`);
  issues.forEach((m) => bad(name + ' -> ' + m));
}

/* ---------- 表格逐格完整性：源码单元格与渲染结果一一对应，无丢格/串列 ---------- */
function splitRow(line) {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = []; let cur = '', tick = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '\\' && t[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '`') { tick = !tick; cur += c; continue; }
    if (c === '|' && !tick) { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  return cells;
}
const stripMd = (s) => s
  .replace(/`([^`]*)`/g, '$1').replace(/\*\*|__|~~|\*|_/g, '')
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
const stripHtml = (s) => s
  .replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
/* 两侧统一归一化：源码侧无法区分「强调标记」与「标识符里的下划线」，
   而下划线在行内代码中必须原样保留，故比对时两边一起去掉这些符号 */
const norm = (s) => s.replace(/[`*_~]/g, '').replace(/\s+/g, ' ').trim();

let tableChecked = 0;
for (const d of docs) {
  const lines = d.text.replace(/\r\n?/g, '\n').split('\n');
  const h = Core.render(d.text, makeCtx(d.path)).html;
  const rendered = [...h.matchAll(/<table>[\s\S]*?<\/table>/g)].map((m) => m[0]);
  let ti = -1, fence = null;
  for (let i = 0; i < lines.length; i++) {
    const fm = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (fm) { const ch = fm[1][0]; if (!fence) fence = ch; else if (ch === fence) fence = null; continue; }
    if (fence) continue;
    const nxt = lines[i + 1] || '';
    if (!(lines[i].includes('|') && /^[|\s:-]+$/.test(nxt.trim()) && /-/.test(nxt) && nxt.includes('|'))) continue;
    ti++;
    const head = splitRow(lines[i]);
    const renderedRows = [...rendered[ti].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
    const srcRows = [head];
    i += 2;
    while (i < lines.length && lines[i].trim() && lines[i].includes('|')) { srcRows.push(splitRow(lines[i])); i++; }
    i--;
    if (renderedRows.length !== srcRows.length) bad(`${d.path} 表${ti + 1}: 行数 渲染=${renderedRows.length} 源码=${srcRows.length}`);
    for (let r = 0; r < srcRows.length; r++) {
      if (srcRows[r].length > head.length) bad(`${d.path} 表${ti + 1} 行${r + 1}: 单元格 ${srcRows[r].length} > 表头 ${head.length}（内容被截断）`);
      const rc = [...(renderedRows[r] || '').matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => stripHtml(m[1]));
      const sc = srcRows[r].map(stripMd);
      for (let c = 0; c < Math.min(rc.length, sc.length, head.length); c++) {
        if (norm(rc[c]) !== norm(sc[c])) bad(`${d.path} 表${ti + 1} 行${r + 1} 列${c + 1}: 内容不一致\n      src="${sc[c]}"\n      out="${rc[c]}"`);
      }
    }
    tableChecked++;
  }
}
console.log(`v 表格逐格比对：${tableChecked} 个表格`);

/* ---------- 专项断言（用 fixtures，不依赖任何具体项目的文档） ---------- */
console.log('--- 专项 ---');
const need = (name) => {
  const d = docs.find((x) => x.path.endsWith(name));
  if (!d) { console.log(`x 缺少 fixture：${name}`); fail++; }
  return d;
};

const ind = need('fixtures/缩进代码块.md');
if (ind) {
  const h = Core.render(ind.text, makeCtx(ind.path)).html;
  if (/<pre class="code"><code>[\s\S]*?CONTEXT-MAP\.md/.test(h)) console.log('v 缩进代码块（目录树）已渲染为 pre');
  else { console.log('x 缩进代码块未渲染'); fail++; }
}

const nest = need('fixtures/嵌套列表.md');
if (nest) {
  const h = Core.render(nest.text, makeCtx(nest.path)).html;
  const ulN = (h.match(/<ul>/g) || []).length, olN = (h.match(/<ol>/g) || []).length;
  if (ulN >= 8 && olN >= 5) console.log(`v 列表渲染 ul=${ulN} ol=${olN}`);
  else { console.log(`x 列表渲染异常 ul=${ulN} ol=${olN}`); fail++; }
}

const ref = need('fixtures/交叉引用.md');
if (ref) {
  const h = Core.render(ref.text, makeCtx(ref.path)).html;
  const secN = (h.match(/class="secref"/g) || []).length;
  const docN = (h.match(/class="docref"/g) || []).length;
  if (secN >= 3) console.log(`v §章节引用生成跳转（${secN} 处）`);
  else { console.log(`x 章节引用未生成链接（${secN} 处）`); fail++; }
  if (docN >= 3) console.log(`v 行内代码 / 链接生成跨文档跳转（${docN} 处）`);
  else { console.log(`x 跨文档链接未生成（${docN} 处）`); fail++; }
  if (/§9\.9/.test(h) && !/§9\.9<\/a>/.test(h)) console.log('v 不存在的章节编号保持原样');
  else { console.log('x 不存在的章节编号被错误链接'); fail++; }
}

/* ---------- 跨文档章节引用：「父文档 §4.1」要跳到父文档，而不是本文档的同名编号 ---------- */
const xref = need('fixtures/子文档-引用父文档.md');
const parent = need('fixtures/父文档.md');
if (xref && parent) {
  const ctx = makeCtx(xref.path);
  const info = Core.parseRefs(xref.text);
  const aliases = Object.keys(info.byAlias);
  if (aliases.length === 2 && aliases.includes('父文档') && aliases.includes('总览'))
    console.log(`v 文首声明解析出 ${aliases.length} 个别名（${aliases.join('、')}）`);
  else { console.log('x 文首声明解析异常: ' + JSON.stringify(info.items)); fail++; }

  ctx.refs = {};
  info.items.forEach((it) => { const r = ctx.resolveDoc(it.target); if (r) ctx.refs[it.alias] = r.path; });
  ctx.declLines = info.lineSet;
  const h = Core.render(xref.text, ctx).html;

  if (!/父文档指|总览:|&lt;!--/.test(h)) console.log('v 声明行不参与正文渲染');
  else { console.log('x 声明行漏进了正文'); fail++; }

  const hrefTo = (p, num) => ctx.docHref(p, sectionMaps[p][num]);
  const anchors = [...h.matchAll(/<a class="([^"]*)"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)]
    .map((m) => ({ cls: m[1], href: m[2].replace(/&amp;/g, '&'), text: m[3].replace(/<[^>]+>/g, '').trim() }));

  const cases = [
    ['父文档 §4.3', hrefTo(parent.path, '4.3'), 'secref xref'],           // 别名写法 -> 父文档的 4.3
    ['父文档§2.1', hrefTo(parent.path, '2.1'), 'secref xref'],            // 别名与 § 之间没空格
    ['总览 §4.1', hrefTo(parent.path, '4.1'), 'secref xref'],             // 第二条声明
    ['docs/fixtures/父文档.md §1.1', hrefTo(parent.path, '1.1'), 'docref xref'],   // 零声明写法：路径
    ['父文档.md §4.1', hrefTo(parent.path, '4.1'), 'docref xref'],        // 零声明写法：只写文件名
    ['§4.3', hrefTo(xref.path, '4.3'), 'secref'],                          // 裸编号仍然指本文档
  ];
  let okN = 0;
  for (const [label, want, cls] of cases) {
    const a = anchors.find((x) => x.text === label);
    if (!a) { console.log(`x 没找到引用链接：${label}`); fail++; continue; }
    if (a.href !== want) { console.log(`x ${label} 跳错了：${a.href}\n      期望 ${want}`); fail++; continue; }
    if (!cls.split(/\s+/).every((c) => a.cls.split(/\s+/).includes(c))) { console.log(`x ${label} 的 class 少了 ${cls}（实为 ${a.cls}）`); fail++; continue; }
    okN++;
  }
  if (okN === cases.length) console.log(`v 跨文档章节引用跳对目标（${okN} 处，含裸编号只指本文档）`);

  /* 兜底分支必须有触发条件成立的用例：目标文档里没有 §9.9 */
  const miss = [['父文档 §9.9', 'secref xref missing'], ['父文档.md §9.9', 'docref xref missing']];
  let missN = 0;
  for (const [label, cls] of miss) {
    const a = anchors.find((x) => x.text === label);
    if (!a) { console.log(`x 没找到缺失编号的引用：${label}`); fail++; continue; }
    if (a.cls !== cls) { console.log(`x ${label} 的 class 应为 ${cls}（实为 ${a.cls}）`); fail++; continue; }
    if (a.href !== ctx.docHref(parent.path)) { console.log(`x ${label} 应降级到父文档顶部，实为 ${a.href}`); fail++; continue; }
    missN++;
  }
  if (missN === miss.length) console.log('v 目标里没有该编号时降级到目标文档顶部并标 missing（2 处）');
}

/* ---------- 文首声明的边界：既不漏吞，也不误吞正文 ---------- */
{
  const prelude = Core.parseRefs('父文档指: `docs/a.md`\n<!-- 父文档: docs/b.md -->\n\n# 标题\n\n总览: docs/c.md\n\n正文。\n');
  if (prelude.items.length === 2 && prelude.byAlias['父文档'] === 'docs/a.md' &&
      prelude.lineSet[0] && prelude.lineSet[1] && prelude.lineSet[5])
    console.log('v 声明写在标题前后都能认；重复别名只认第一条，但两行都从正文抹掉');
  else { console.log('x 声明区解析异常: ' + JSON.stringify(prelude.items) + ' lineSet=' + JSON.stringify(prelude.lineSet)); fail++; }

  const afterBody = Core.parseRefs('# 标题\n\n正文第一段。\n\n相关文档: docs/x.md\n');
  if (!afterBody.items.length) console.log('v 正文开始后不再把「XX: docs/x.md」当声明（不会误吞正文）');
  else { console.log('x 正文里的冒号行被误当声明: ' + JSON.stringify(afterBody.items)); fail++; }

  const notMd = Core.parseRefs('说明: 见 README\n');
  if (!notMd.items.length && !Object.keys(notMd.lineSet).length)
    console.log('v 目标是 .md 之外的「XX: yy」不当声明（原样保留在正文里）');
  else { console.log('x 非 .md 目标被误当声明: ' + JSON.stringify(notMd.items)); fail++; }
}

const evil = Core.render('# T\n\n<script>alert(1)</script>\n\n| a | b |\n| --- | --- |\n| <img src=x onerror=1> | `y` |\n', makeCtx('docs/x.md')).html;
if (!/<script/i.test(evil) && /&lt;script&gt;/.test(evil)) console.log('v 原始 HTML 被转义（无注入）');
else { console.log('x HTML 转义有问题: ' + evil.slice(0, 160)); fail++; }

const cjk = Core.render('单上下文仓库（绝大多数仓库）：\n触发）会在术语或决策真正确定时按需创建。\n', makeCtx('docs/x.md')).html;
if (cjk.includes('：触发）')) console.log('v 中文软换行折叠（CJK 间不插空格）');
else { console.log('x 中文软换行异常: ' + cjk); fail++; }

const tbl = Core.render('| a | b |\n|:--|--:|\n| `x\\|y` | **粗** |\n', makeCtx('docs/x.md')).html;
if (/text-align:left/.test(tbl) && /text-align:right/.test(tbl) && tbl.includes('<code>x|y</code>') && tbl.includes('<strong>粗</strong>'))
  console.log('v 表格对齐 / 转义竖线 / 行内强调');
else { console.log('x 表格处理异常: ' + tbl); fail++; }

const fence = Core.render('文本\n\n```\n# 不是标题\n**原样**\n```\n\n尾段\n', makeCtx('docs/x.md'));
if (fence.headings.length === 0 && fence.html.includes('# 不是标题')) console.log('v 围栏代码块内不解析标题/强调');
else { console.log('x 围栏代码块处理异常: ' + fence.html); fail++; }

console.log(fail ? `\n===== 失败 ${fail} 项 =====` : '\n===== 全部通过 =====');
process.exit(fail ? 1 : 0);
