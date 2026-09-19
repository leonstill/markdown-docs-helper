/* =====================================================================
 * 诊断：为什么 --check 说过期
 *
 * 把页面内置快照 / docs-index.json 与磁盘上的 markdown 逐一比对，
 * 打印「新增 / 有变化 / 已删除」的文档，直接指出差异来源。
 *
 * 用法：node test/why-stale.mjs [目录]
 * ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const DOCS_DIR = argv[0] ? path.resolve(argv[0]) : path.join(ROOT, 'docs');

const html = fs.readFileSync(path.join(ROOT, 'md-viewer.html'), 'utf8');
const snap = JSON.parse(/<script id="docs-snapshot" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs-index.json'), 'utf8'));

const disk = {};
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.md$/i.test(e.name)) {
      const st = fs.statSync(p);
      disk['docs/' + path.relative(DOCS_DIR, p).replace(/\\/g, '/')] = { size: st.size, mtime: st.mtime.toISOString() };
    }
  }
})(DOCS_DIR);

console.log(`文档目录：${DOCS_DIR}`);
console.log(`内置快照：generatedAt=${snap.generatedAt} count=${snap.count} 条目=${snap.docs.length}`);
console.log(`docs-index.json：generatedAt=${idx.generatedAt} 条目=${idx.docs.length}`);
console.log(`磁盘 .md 文件：${Object.keys(disk).length}`);

let diff = 0;
const emb = new Map(snap.docs.map((d) => [d.path, d]));
for (const [p, s] of Object.entries(disk)) {
  const e = emb.get(p);
  if (!e) { console.log(`  + 磁盘新增（快照里没有）：${p}`); diff++; continue; }
  const mt = new Date(e.mtime).toISOString();
  if (e.size !== s.size || mt !== s.mtime) {
    console.log(`  ~ 有变化：${p}\n      快照 size=${e.size} mtime=${mt}\n      磁盘 size=${s.size} mtime=${s.mtime}`);
    diff++;
  }
  emb.delete(p);
}
for (const p of emb.keys()) { console.log(`  - 快照里有、磁盘已无：${p}`); diff++; }

const idxMap = new Map(idx.docs.map((d) => [d.path, d]));
for (const [p, s] of Object.entries(disk)) {
  const e = idxMap.get(p);
  if (!e) console.log(`  [index] 缺：${p}`);
  else if (e.size !== s.size) console.log(`  [index] size 不同：${p} ${e.size} vs ${s.size}`);
}

console.log(diff ? `\n差异 ${diff} 处 —— 跑一次 node build-docs.mjs 即可刷新` : '\n没有差异：内置数据与磁盘一致');
process.exit(diff ? 1 : 0);
