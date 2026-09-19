/* =====================================================================
 * 静态服务冒烟测试（纯 Node，不需要浏览器）
 *
 * 覆盖实时模式的全部路由与只读保证：
 *   · /                     → 302 到 /md-viewer.html
 *   · /md-viewer.html       → 200，页面里能找到内置数据块
 *   · /docs-index.json      → 200，篇数与磁盘一致、路径都带 docs/ 前缀
 *   · /docs/<每篇文档>       → 200，正文非空
 *   · /docs/%2e%2e/...      → 403（目录穿越被拦）
 *   · /favicon.ico          → 204；未知路径 → 404
 *   · 跑完以后文档目录的文件清单与 mtime 完全没变（只读）
 *
 * 用法：
 *   node test/serve-smoke.mjs                       # 只测工程自带的 docs/
 *   node test/serve-smoke.mjs D:\some\docs           # 额外再测一个外部目录
 * ===================================================================== */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'v' : 'x'} ${label}${ok || detail === undefined ? '' : '   <- ' + detail}`);
  if (!ok) fail++;
};

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

/** 文档目录快照：用来证明工具没有写过文档 */
function snapshotDir(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = fs.statSync(p);
        out.push(`${path.relative(dir, p)}|${st.size}|${st.mtime.toISOString()}`);
      }
    }
  })(dir);
  return out.join('\n');
}

async function start(port, docsDir) {
  const args = [path.join(ROOT, 'build-docs.mjs'), '--serve', '--port', String(port)];
  if (docsDir) args.push(docsDir);
  const proc = spawn(process.execPath, args, { cwd: ROOT, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(base + '/docs-index.json'); if (r.ok) return { proc, base }; } catch (e) {}
    await sleep(100);
  }
  proc.kill();
  throw new Error('服务没起来（端口 ' + port + '）');
}

async function run(label, docsDir) {
  console.log(`\n--- ${label} ---`);
  const realDocs = docsDir || path.join(ROOT, 'docs');
  const before = snapshotDir(realDocs);
  const port = await freePort();
  const { proc, base } = await start(port, docsDir);
  try {
    // 1. 根路径重定向
    const root = await fetch(base + '/', { redirect: 'manual' });
    check(root.status === 302 && /\/md-viewer\.html$/.test(root.headers.get('location') || ''),
      'GET / 重定向到 /md-viewer.html', `${root.status} ${root.headers.get('location')}`);

    // 2. 页面本体
    const page = await fetch(base + '/md-viewer.html');
    const pageText = await page.text();
    check(page.status === 200 && /text\/html/.test(page.headers.get('content-type') || ''),
      'GET /md-viewer.html 返回 HTML', String(page.status));
    check(pageText.includes('id="docs-snapshot"') && pageText.includes('id="md-core"'),
      '页面里含内置数据块与渲染器');

    // 3. 索引
    const idxRes = await fetch(base + '/docs-index.json');
    const idx = await idxRes.json();
    const onDisk = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.md$/i.test(e.name)) onDisk.push('docs/' + path.relative(realDocs, p).replace(/\\/g, '/'));
      }
    })(realDocs);
    check(idxRes.status === 200 && idx.docs.length === onDisk.length,
      `索引篇数与磁盘一致（${idx.docs.length} / ${onDisk.length}）`);
    check(idx.docs.every((d) => d.path.startsWith('docs/') && !('text' in d)),
      '索引路径统一带 docs/ 前缀、且不含正文');
    check(idx.docs.every((d) => onDisk.includes(d.path)), '索引里的每篇文档磁盘上都存在');

    // 4. 每篇文档都能按索引路径取到
    const bodies = await Promise.all(idx.docs.map(async (d) => {
      const r = await fetch(base + '/' + d.path);
      const t = await r.text();
      return r.ok && t.trim().length > 0 && /text\/markdown/.test(r.headers.get('content-type') || '');
    }));
    check(bodies.every(Boolean), `全部 ${idx.docs.length} 篇文档都能读到正文（text/markdown）`);

    // 5. 目录穿越与 404
    //    注意不能用 /docs/%2e%2e/... —— URL 解析阶段就会把 %2e%2e 规范化掉，
    //    根本到不了护栏；用 %2f（编码的斜杠）才能真正把 ".." 送进服务端解码后。
    const evil1 = await fetch(base + '/docs/..%2f..%2fREADME.md', { redirect: 'manual' });
    check(evil1.status === 403 || evil1.status === 404, '穿越文档目录（/docs/..%2f…）被拒绝', String(evil1.status));
    const evil2 = await fetch(base + '/..%2fREADME.md', { redirect: 'manual' });
    check(evil2.status === 403 || evil2.status === 404, '穿越工程根（/..%2f…）被拒绝', String(evil2.status));
    const miss = await fetch(base + '/no-such-file.txt');
    check(miss.status === 404, '未知路径返回 404', String(miss.status));
    const fav = await fetch(base + '/favicon.ico');
    check(fav.status === 204, '/favicon.ico 返回 204', String(fav.status));

    // 6. 只读：文档目录一个字都没变
    check(snapshotDir(realDocs) === before, '文档目录的文件清单与 mtime 未变（只读保证）');
  } finally {
    proc.kill();
    await sleep(300);
  }
}

try {
  await run('默认 docs/', null);
  const ext = process.argv[2];
  if (ext) {
    const dir = path.resolve(ext);
    if (!fs.existsSync(dir)) throw new Error('目录不存在：' + dir);
    await run('外部目录 ' + dir, dir);
  } else {
    console.log('\n（想顺便验证外部目录：node test/serve-smoke.mjs <目录>）');
  }
  console.log(fail ? `\n===== 失败 ${fail} 项 =====` : '\n===== 全部通过 =====');
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error('x ' + (e && e.stack || e));
  process.exit(1);
}
