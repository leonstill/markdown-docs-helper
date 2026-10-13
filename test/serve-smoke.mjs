/* =====================================================================
 * 静态服务冒烟测试（纯 Node，不需要浏览器）
 *
 * 覆盖实时模式的全部路由与只读保证：
 *   · /                     → 302 到 /index.html（实时版默认入口）
 *   · /index.html           → 200，引擎走本地外链、快照为空、无互联网资源
 *   · /md-viewer.html       → 200，离线单文件版，引擎内联
 *   · /vendor/markmap/*.js  → 200（实时版页面靠它们渲染思维导图）
 *   · /docs-index.json      → 200，篇数与磁盘一致（.md + .mermaid）、路径都带 docs/ 前缀
 *   · /docs/<每篇文档>       → 200，正文非空
 *   · /docs/%2e%2e/...      → 403（目录穿越被拦）
 *   · /favicon.ico          → 204；未知路径 → 404
 *   · 跑完以后文档目录的文件清单与 mtime 完全没变（只读）
 *   · 工程产物 md-viewer.html / docs-index.json / index.html / config.json 一个都没被写过
 *     —— --serve 全程不落盘，实时版页面在内存里给出
 *
 * 前置：先跑一次 node build-docs.mjs（三个产物只由这条明确的构建命令生成）。
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

/** 工程产物指纹：--serve 一个都不该碰（实时版页面在内存里给，产物只由构建命令写） */
const ARTIFACTS = ['md-viewer.html', 'docs-index.json', 'index.html', 'config.json'];
function fingerprintArtifacts() {
  return ARTIFACTS.map((name) => {
    const st = fs.statSync(path.join(ROOT, name), { throwIfNoEntry: false });
    return `${name}|${st ? `${st.size}|${st.mtime.toISOString()}` : '缺失'}`;
  }).join('\n');
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
  const artifactsBefore = fingerprintArtifacts();
  const port = await freePort();
  const { proc, base } = await start(port, docsDir);
  try {
    // 1. 根路径重定向到实时版
    const root = await fetch(base + '/', { redirect: 'manual' });
    check(root.status === 302 && /\/index\.html$/.test(root.headers.get('location') || ''),
      'GET / 重定向到 /index.html', `${root.status} ${root.headers.get('location')}`);

    // 2. 实时版页面：引擎本地外链、快照为空、无互联网资源
    const rt = await fetch(base + '/index.html');
    const rtText = await rt.text();
    check(rt.status === 200 && /text\/html/.test(rt.headers.get('content-type') || ''),
      'GET /index.html 返回 HTML', String(rt.status));
    const bundleIds = ['vendor-d3', 'vendor-markmap-lib', 'vendor-markmap-view'];
    check(bundleIds.every((id) => new RegExp(`<script id="${id}" src="vendor/markmap/[^"]+"></script>`).test(rtText)),
      '实时版三个引擎都走本地外链');
    check(/<script id="docs-snapshot" type="application\/json">\{\}<\/script>/.test(rtText),
      '实时版内置快照为空（靠 docs-index.json 实时取）');
    const online = [...rtText.matchAll(/(?:src|href)\s*=\s*["'](?:https?:)?\/\/[^"']*/gi)].map((m) => m[0]);
    check(online.length === 0, '实时版没有任何互联网资源引用', online.join(' '));

    // 2b. 离线版页面仍可从服务里打开（引擎内联）
    const page = await fetch(base + '/md-viewer.html');
    const pageText = await page.text();
    check(page.status === 200 && /text\/html/.test(page.headers.get('content-type') || ''),
      'GET /md-viewer.html 返回 HTML', String(page.status));
    check(pageText.includes('id="docs-snapshot"') && pageText.includes('id="md-core"'),
      '离线版页面里含内置数据块与渲染器');

    // 2c. 页面外链的资源必须都能取到，否则页面会白板
    for (const rel of ['assets/viewer.css', 'assets/mindmap-core.js', 'assets/md-core.js', 'assets/md-app.js',
                       'vendor/markmap/d3.min.js', 'vendor/markmap/markmap-lib.iife.js', 'vendor/markmap/markmap-view.browser.js']) {
      const r = await fetch(base + '/' + rel);
      const body = await r.text();
      check(r.status === 200 && body.length > 1000 && /text\/(css|javascript)/.test(r.headers.get('content-type') || ''),
        `GET /${rel} 返回资源`, `${r.status} ${r.headers.get('content-type')} ${body.length}B`);
    }

    // 3. 索引
    const idxRes = await fetch(base + '/docs-index.json');
    const idx = await idxRes.json();
    const onDisk = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(md|mermaid)$/i.test(e.name)) onDisk.push('docs/' + path.relative(realDocs, p).replace(/\\/g, '/'));
      }
    })(realDocs);
    check(idxRes.status === 200 && idx.docs.length === onDisk.length,
      `索引篇数与磁盘一致（${idx.docs.length} / ${onDisk.length}）`);
    check(idx.docs.every((d) => d.path.startsWith('docs/') && !('text' in d)),
      '索引路径统一带 docs/ 前缀、且不含正文');
    check(idx.docs.every((d) => onDisk.includes(d.path)), '索引里的每篇文档磁盘上都存在');
    check(idx.docs.filter((d) => d.kind === 'mindmap').every((d) => /\.mermaid$/i.test(d.path)),
      `索引里的思维导图条目后缀正确（${idx.docs.filter((d) => d.kind === 'mindmap').length} 篇）`);

    // 4. 每篇文档都能按索引路径取到（.md 是 text/markdown，.mermaid 是 text/plain）
    const bodies = await Promise.all(idx.docs.map(async (d) => {
      const r = await fetch(base + '/' + d.path);
      const t = await r.text();
      const type = r.headers.get('content-type') || '';
      const want = /\.mermaid$/i.test(d.path) ? /text\/plain/ : /text\/markdown/;
      return r.ok && t.trim().length > 0 && want.test(type);
    }));
    check(bodies.every(Boolean), `全部 ${idx.docs.length} 篇文档都能读到正文（类型正确）`);

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

    // 7. --serve 不写盘：产物一个都没被碰过（实时版页面在内存里给出）
    check(fingerprintArtifacts() === artifactsBefore,
      '工程产物的清单与 mtime 未变（--serve 不写 md-viewer.html / docs-index.json / index.html）',
      fingerprintArtifacts().split('\n').filter((line, i) => line !== artifactsBefore.split('\n')[i]).join('  '));
  } finally {
    proc.kill();
    await sleep(300);
  }
}

if (!fs.existsSync(path.join(ROOT, 'md-viewer.html'))) {
  console.log('x 还没生成 md-viewer.html —— 先跑一次 node build-docs.mjs（--serve 不写产物）');
  process.exit(1);
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
