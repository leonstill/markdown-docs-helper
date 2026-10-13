/* =====================================================================
 * 实时版页面检查（纯 Node，不需要浏览器）：index.html
 *
 * index.html 是 --serve 的默认入口，由 page.template.html 生成。它必须：
 *   · 与模板同源：外壳一致，只有「引擎写法」和「快照」两处不同
 *   · 引擎全是本地外链（vendor/markmap/*.js、vendor/mermaid/*.js），块内不能还内联着源码
 *   · 内置快照为空（实时模式每次刷新都去 fetch docs-index.json）
 *   · 只引用工程内的本地资源，绝不出现指向互联网的 src/href —— 这是本工具的硬承诺
 *   · 引用的本地文件都真实存在（少一个文件页面就白板）
 *
 * 用法：node test/check-realtime.mjs      （失败退出码 1）
 * 前置：先跑一次 node build-docs.mjs（三个产物都只由这条构建命令生成）
 * ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(ROOT, 'page.template.html');
const INDEX_HTML = path.join(ROOT, 'index.html');

let fail = 0;
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'v' : 'x'} ${label}${ok || detail === undefined ? '' : '   <- ' + detail}`);
  if (!ok) fail++;
};

if (!fs.existsSync(INDEX_HTML)) {
  console.log('x 还没生成 index.html —— 跑一次 node build-docs.mjs 再来');
  process.exit(1);
}
const html = fs.readFileSync(INDEX_HTML, 'utf8');
const tpl = fs.readFileSync(TEMPLATE, 'utf8');

/* ---------- 引擎清单直接读 build-docs.mjs，加/减引擎时这里跟着走，不会各写一份 ---------- */
const src = fs.readFileSync(path.join(ROOT, 'build-docs.mjs'), 'utf8');
const BUNDLES = [...src.matchAll(/\{\s*id:\s*'([^']+)',\s*file:\s*'([^']+)'/g)]
  .map((x) => ({ id: x[1], file: x[2] }));
check(BUNDLES.length > 0, `从 build-docs.mjs 读到 ${BUNDLES.length} 个引擎`);

console.log(`\n--- ${path.basename(INDEX_HTML)}（${(html.length / 1024).toFixed(1)} KB）---`);

/* 1. 引擎：改成外链、且块内为空。
      config 里关掉的引擎（mermaid.enabled = false）会留一个 data-disabled="1" 的空块。 */
for (const b of BUNDLES) {
  const m = new RegExp(`<script id="${b.id}"([^>]*)>([\\s\\S]*?)</script>`).exec(html);
  check(!!m, `${b.id} 引擎块存在`);
  if (!m) continue;
  check(m[2].trim() === '', `${b.id} 块内没有残留内联源码`);
  if (/data-disabled="1"/.test(m[1])) {
    check(!/\ssrc="/.test(m[1]), `${b.id} 被 config 关掉了（无外链、留空块）`);
    continue;
  }
  const em = /\ssrc="([^"]+)"/.exec(m[1]);
  check(!!em, `${b.id} 走本地外链`);
  if (em) {
    check(em[1].endsWith('/' + b.file), `${b.id} 外链指向 ${b.file}（实际 ${em[1]}）`);
    check(fs.existsSync(path.join(ROOT, em[1])), `本地引擎文件存在：${em[1]}`);
  }
}

/* 2. 快照置空：实时模式必须依赖 docs-index.json */
const sm = /<script id="docs-snapshot" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
check(!!sm, '有 docs-snapshot 块');
if (sm) {
  let empty = false;
  try { const o = JSON.parse(sm[1]); empty = Object.keys(o).length === 0; } catch (e) { empty = false; }
  check(empty, '内置快照为空（不背一份会过期的文档副本）', JSON.stringify(sm[1].slice(0, 40)));
}

/* 3. 硬承诺：没有任何互联网资源引用 */
const online = [...html.matchAll(/(?:src|href)\s*=\s*["'](?:https?:)?\/\/[^"']*/gi)].map((m) => m[0]);
check(online.length === 0, '没有任何指向互联网的 src/href', online.join(' '));

/* 4. 本地引用都要真实存在，否则页面白板 */
const refs = [...html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)].map((m) => m[1])
  .filter((u) => !/^(data:|#|mailto:|javascript:)/i.test(u));
check(refs.length >= 8, `外链本地资源 ${refs.length} 个（CSS + 4 引擎 + 4 自研脚本）`);
for (const rel of refs) {
  check(fs.existsSync(path.join(ROOT, rel)), `本地资源存在：${rel}`);
}

/* 5. 与模板同源：把两侧的占位块内容抹掉后应当完全一致 */
const strip = (text) => text
  .replace(/<script id="(vendor-d3|vendor-markmap-lib|vendor-markmap-view|vendor-mermaid)"[^>]*>[\s\S]*?<\/script>/g, '<X>')
  .replace(/<script id="(viewer-config|docs-snapshot)"([^>]*)>[\s\S]*?<\/script>/g, '<X>');
check(strip(html) === strip(tpl), '外壳与 page.template.html 完全一致（只有占位块内容不同）');

console.log(fail ? `\n===== 失败 ${fail} 项 =====` : '\n===== 全部通过 =====');
process.exit(fail ? 1 : 0);
