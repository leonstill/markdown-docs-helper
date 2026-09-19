/* =====================================================================
 * 思维导图解析回归（纯 Node，不需要浏览器）
 *
 * 做法：把 assets/mindmap-core.js（页面用 <script src> 外链的解析器源码）读进来，
 *   在 vm 里跑，然后
 *   · 用内置样例文档（docs/**\/*.mermaid）验证层级、标题、Markdown 转换
 *   · 用 test/fixtures/mindmap/*.mermaid 逐条验证形状、缩进、注释等边界
 *   · 交叉验证：自己写一个独立的缩进扫描器，比对节点总数与最大层级
 *
 * 用法：node test/verify-mindmap.mjs      （失败退出码 1）
 * ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEWER = path.join(ROOT, 'md-viewer.html');
const CORE = path.join(ROOT, 'assets', 'mindmap-core.js');
const DOCS = path.join(ROOT, 'docs');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'mindmap');

let fail = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? 'v' : 'x'} ${label}`);
  if (!ok) fail++;
};

/* ---------- 读 mindmap-core 源码并求值 ---------- */
if (!fs.existsSync(CORE)) { console.log('x 未找到 assets/mindmap-core.js'); process.exit(1); }
const coreSrc = fs.readFileSync(CORE, 'utf8');
/* 页面确实外链了这份源码，避免"index 改了源码没接线" */
const linked = /<script id="mindmap-core" src="assets\/mindmap-core\.js">/.test(fs.readFileSync(VIEWER, 'utf8'));
check(linked, '页面外链 assets/mindmap-core.js');
const sandbox = { module: { exports: {} }, console };
vm.createContext(sandbox);
try {
  new vm.Script(coreSrc + '\nmodule.exports = MindmapCore;', { filename: 'mindmap-core.js' }).runInContext(sandbox);
} catch (e) {
  console.log('x mindmap-core 语法错误：' + e.message);
  process.exit(1);
}
const MM = sandbox.module.exports;
check(!!MM && typeof MM.parse === 'function', 'mindmap-core 已抽出（parse / toMarkdown / outline）');

/* ---------- 独立实现：只按缩进扫节点，用来交叉验证 ---------- */
function independentScan(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  let started = false, count = 0, maxDepth = 0;
  const stack = [];
  for (const raw of lines) {
    if (/^\s*%%/.test(raw) || !raw.trim()) continue;
    if (!started) {
      if (/^\s*mindmap\s*$/i.test(raw)) { started = true; continue; }
      started = true;   // 宽容：没有声明行也照样扫
    }
    let width = 0;
    for (const ch of raw) { if (ch === ' ') width++; else if (ch === '\t') width += 4; else break; }
    while (stack.length && stack[stack.length - 1] >= width) stack.pop();
    stack.push(width);
    count++;
    maxDepth = Math.max(maxDepth, stack.length);
  }
  return { count, depth: maxDepth };
}

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

/* ---------- 样例文档 ---------- */
function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else out.push({ rel, full: path.join(dir, e.name) });
  }
  return out;
}
const samples = walk(DOCS).filter((f) => /\.mermaid$/i.test(f.rel));
console.log(`\n--- 内置样例（${samples.length} 个 .mermaid）---`);
check(samples.length > 0, 'docs/ 下存在 .mermaid 样例');
for (const f of samples) {
  const text = fs.readFileSync(f.full, 'utf8');
  const tree = MM.parse(text);
  const stat = MM.summary(tree);
  const ref = independentScan(text);
  const okDepth = stat.depth + 1 === ref.depth;
  console.log(`  v ${f.rel}  节点 ${stat.count} 层 ${stat.depth + 1} 根「${tree.root && tree.root.text}」`);
  check(stat.count === ref.count, `${f.rel}：节点数与独立扫描一致（${stat.count} / ${ref.count}）`);
  check(okDepth, `${f.rel}：层级数与独立扫描一致（${stat.depth + 1} / ${ref.depth}）`);
  check(!!tree.root && !!tree.root.text, `${f.rel}：解析出根节点文字`);

  const md = MM.toMarkdown(tree);
  check(/^# /.test(md), `${f.rel}：Markdown 以一级标题开头`);
  check((md.match(/^## /gm) || []).length === tree.root.children.length,
    `${f.rel}：二级标题数 = 一级分支数（${tree.root.children.length}）`);
  check(!/^###/m.test(md), `${f.rel}：三级以下用列表，不用三级标题`);
  const outlineCount = (function count(list) {
    return list.reduce((n, it) => n + 1 + count(it.children), 0);
  })(MM.outline(tree));
  check(outlineCount === stat.count - 1, `${f.rel}：大纲条目数 = 节点数 - 1（根不进大纲）`);

  /* 转义：行首的 # 不能被 markmap 当成标题 */
  const mdLines = md.split('\n');
  const badHash = mdLines.some((l) => /^\s*#/.test(l) && !/^\s*#{1,2} /.test(l));
  check(!badHash, `${f.rel}：没有会变成意外标题的行`);
}
if (samples.length) {
  const text = fs.readFileSync(samples[0].full, 'utf8');
  const tree = MM.parse(text);
  const md = MM.toMarkdown(tree);
  check(md.includes('#10') && !/^#10/m.test(md.replace(/^## /gm, '')), '节点文字里的 #10 保持原样且不成为标题');
}

/* ---------- fixtures ---------- */
console.log('\n--- fixtures 边界 ---');
const hasFixtures = fs.existsSync(FIXTURES);
check(hasFixtures, 'test/fixtures/mindmap/ 存在');

if (hasFixtures) {
  /* 1. 基本层级 + 各种形状 */
  const t1 = MM.parse(readFixture('形状.mermaid'));
  const shapes = {};
  t1.nodes.forEach((n) => { shapes[n.shape] = (shapes[n.shape] || 0) + 1; });
  check(t1.root && t1.root.text === '圆根', '((圆根)) 取到文字（根节点带 id 也认）');
  check(shapes.circle >= 1 && shapes.square >= 1 && shapes.round >= 1 &&
        shapes.hexagon >= 1 && shapes.bang >= 1 && shapes.cloud >= 1 && shapes.default >= 1,
    '六种形状 + 纯文本都能识别：' + JSON.stringify(shapes));
  const square = t1.nodes.find((n) => n.shape === 'square');
  check(square && square.text === '方括号节点' && square.id === 'id1', 'id[方括号节点] 去掉 id 只留文字');
  const bang = t1.nodes.find((n) => n.shape === 'bang');
  const cloud = t1.nodes.find((n) => n.shape === 'cloud');
  check(bang && bang.text === '爆炸形状' && bang.id === 'id4', '))爆炸形状(( 取到文字');
  check(cloud && cloud.text === '云形状' && cloud.id === 'id5', ')云形状( 取到文字');
  const round = t1.nodes.find((n) => n.shape === 'round');
  check(round && round.text === '圆角节点', '(圆角节点) 取到文字');
  const hexa = t1.nodes.find((n) => n.shape === 'hexagon');
  check(hexa && hexa.text === '六边形节点', '{{六边形节点}} 取到文字');
  check(t1.nodes.find((n) => n.text === '带 空格 的 纯文本'), '纯文本里的空格全部保留');

  /* 2. tab 与不一致缩进（tab 记 4 个空格，所以 `<TAB>` 子节点比 4 空格深一级） */
  const tabText = readFixture('tab与缩进.mermaid');
  const t2 = MM.parse(tabText);
  const tabBranch = t2.nodes.find((n) => n.text === '制表符分支');
  const spaceBranch = t2.nodes.find((n) => n.text === '空格分支');
  const tabKid = t2.nodes.find((n) => n.text === '制表符子节点一');
  const spaceKid = t2.nodes.find((n) => n.text === '子节点甲');
  check(t2.root && t2.root.text === '根', 'tab 缩进的文件解析出根节点');
  check(!!tabBranch && !!spaceBranch && tabBranch.parent === t2.root && spaceBranch.parent === t2.root,
    '文件里用 tab 缩进的一级分支挂在根下');
  check(!!tabKid && tabKid.parent === tabBranch, 'tab + 2 空格的子节点挂在 tab 分支下');
  check(!!spaceKid && spaceKid.parent === spaceBranch, '4 空格 + 2 空格的子节点挂在空格分支下');
  check(tabKid.indent === 6 && spaceKid.indent === 6,
    'tab 记 4 个空格：tab+2 空格与 4 空格+2 空格是同一层级');
  check(t2.nodes.length === independentScan(tabText).count,
    'tab 混用的节点数与独立扫描一致');

  /* 3. 注释、CRLF、空行、引号 */
  const t3 = MM.parse(fs.readFileSync(path.join(FIXTURES, '杂项.mermaid'), 'utf8').replace(/\n/g, '\r\n'));
  check(!t3.nodes.some((n) => n.text.indexOf('%%') === 0), '%% 注释行（含 init 指令）被跳过');
  check(t3.root && t3.root.text === '根 节点', '根节点引号内的空格保留');
  const quoted = t3.nodes.find((n) => n.text === '带 空格 的节点');
  check(!!quoted, '纯文本节点里的空格不被当作分隔符');
  check(t3.nodes.some((n) => n.text === '编号 1 的节点'), 'CRLF 行尾没有把 \\r 带进文字');
  const jia = t3.nodes.find((n) => n.text === '子节点甲');
  const yi = t3.nodes.find((n) => n.text === '子节点乙');
  check(!!jia && !!yi && jia.parent === yi.parent && !!jia.parent,
    '注释与空行不会打断父子关系（子节点甲乙同属一个父节点）');

  /* 4. 错误输入不抛异常 */
  for (const [name, text] of [
    ['空文件', ''],
    ['只有声明', 'mindmap\n'],
    ['纯垃圾', 'flowchart TD\n  A-->B\n'],
    ['两棵树', 'mindmap\n  a\n  b\n'],
  ]) {
    let threw = null, t = null;
    try { t = MM.parse(text); } catch (e) { threw = e; }
    check(!threw, `${name}：不抛异常`);
    if (t) check(Array.isArray(t.warnings), `${name}：带 warnings 数组`);
  }
  const tEmpty = MM.parse('mindmap\n');
  check(tEmpty.root === null && tEmpty.warnings.length > 0, '只有声明时给出提示而不是假节点');
  const tTwo = MM.parse('mindmap\n  a\n  b\n');
  check(!!tTwo.root && tTwo.root.children.length === 1,
    '两个平级根节点时第二棵挂到第一棵下（保证只有一棵树）');

  /* 5. 转义 */
  check(MM.mdText('#26 分母口径') === '#26 分母口径', '「#26」不会被转义');
  check(MM.mdText('# 标题') === '\\# 标题', '行首「# 」被转义');
  check(MM.mdText('- 列表') === '\\- 列表', '行首「- 」被转义');
  check(MM.mdText('1. 有序') === '1\\. 有序', '行首「1. 」被转义');
  check(MM.mdText('a*b*c') === 'a\\*b\\*c', '星号被转义');
  check(MM.mdText('`code`') === '\\`code\\`', '反引号被转义');
}

console.log(fail ? `\n✗ ${fail} 项失败` : '\n✓ 全部通过');
process.exit(fail ? 1 : 0);
