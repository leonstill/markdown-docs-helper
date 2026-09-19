/* =====================================================================
 * 产物完整性检查：内置快照 + docs-index.json
 *
 * 校验点：
 *   · 页面里能找到 <script id="docs-snapshot"> 并且 JSON 可解析
 *   · 快照里 < 都被转义成 \u003c（正文含 </script> 也不会提前闭合脚本）
 *   · 快照条目齐全：路径以 .md 结尾、标题与正文非空
 *   · docs-index.json 不带正文，字段齐全，与快照篇数一致
 *
 * 用法：node test/check-snapshot.mjs      （失败退出码 1）
 * 前置：先跑一次 node build-docs.mjs
 * ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';
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

check(!m[1].includes('</script'), '快照 JSON 中没有裸的 "</script"');
check(snap.docs.every((d) => !d.text.includes('</script')), '没有文档的正文原样包含 </script>');
check(snap.docs.every((d) => d.path.endsWith('.md') && d.title && d.text), '每条快照都有路径、标题、正文');
check(snap.count === snap.docs.length, `count 字段与实际条目一致（${snap.count}）`);
check(snap.docsRoot === 'docs/', `docsRoot 前缀为 docs/（实际 ${snap.docsRoot}）`);
const paths = snap.docs.map((d) => d.path);
check(new Set(paths).size === paths.length, '文档路径不重复');
check(snap.docs.every((d) => d.path.startsWith('docs/')), '所有路径都带 docs/ 前缀');

const tags = (html.match(/<script/g) || []).length;
check(tags === 4, `页面里 <script 标签共 4 个（快照 + 配置 + 渲染器 + 应用），实际 ${tags}`);

if (!fs.existsSync(INDEX)) {
  check(false, 'docs-index.json 存在');
} else {
  const idx = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  console.log(`  索引：${idx.docs.length} 篇，生成于 ${idx.generatedAt}`);
  check(idx.docs.length === snap.docs.length, `索引篇数与快照一致（${idx.docs.length}）`);
  check(!idx.docs.some((d) => 'text' in d), '索引里没有正文（实时模式按需读取）');
  const fields = ['path', 'dir', 'name', 'title', 'size', 'mtime'];
  check(idx.docs.every((d) => fields.every((f) => f in d)), '索引字段齐全：' + fields.join(', '));
  check(idx.docs.every((d, i) => d.path === paths[i]), '索引与快照的文档顺序一致');
}

console.log(fail ? `\n===== 失败 ${fail} 项 =====` : '\n===== 全部通过 =====');
process.exit(fail ? 1 : 0);
