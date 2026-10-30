/* =====================================================================
 * 收藏 / 书签 API 测试（纯 Node，不需要浏览器）
 *
 * 覆盖 --serve 下页面对 bookmark.json 的读写通道：
 *   · GET  /api/bookmarks       → 200，JSON 对象（文件不存在时 {}），读取时归一化
 *   · POST /api/bookmarks       → 按条操作（服务端在最新数据上执行）：
 *        fav-toggle / fav-remove   收藏按整篇记（每篇一条）
 *        bmk-toggle / bmk-remove   书签按章节记（每篇每节一条，(path, sec) 唯一）
 *   · GET  /docs-index.json     → 带 docsDirAbs，且等于文档目录的真实绝对路径
 *   · 旧数据（只有整篇、没有 sec、带 ratio）读取时被丢/清洗干净
 *   · 条目清空后该 key 从文件里删掉；写入是原子的（不留 .tmp）
 *   · 坏 JSON / 缺 key / 不认识的 op → 400；其它方法 → 405
 *   · GET /bookmark.json        → 403（用户数据不进静态资源）
 *
 * 测试会临时改写工程根目录的 bookmark.json：开跑前备份，结束时原样还原。
 *
 * 用法：node test/serve-bookmarks.mjs
 * ===================================================================== */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BOOK = path.join(ROOT, 'bookmark.json');
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

async function start(port) {
  const proc = spawn(process.execPath, [path.join(ROOT, 'build-docs.mjs'), '--serve', '--port', String(port)],
    { cwd: ROOT, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(base + '/docs-index.json'); if (r.ok) return { proc, base }; } catch (e) {}
    await sleep(100);
  }
  proc.kill();
  throw new Error('服务没起来（端口 ' + port + '）');
}

const post = (base, body) => fetch(base + '/api/bookmarks', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const getBook = async (base) => (await fetch(base + '/api/bookmarks')).json();
const disk = () => JSON.parse(fs.readFileSync(BOOK, 'utf8'));

const backup = fs.existsSync(BOOK) ? fs.readFileSync(BOOK) : null;

async function run() {
  console.log('--- 收藏 / 书签 API ---');
  const port = await freePort();
  const { proc, base } = await start(port);
  try {
    // 0. 索引里带真实的绝对路径，页面拿它当索引键
    const idx = await (await fetch(base + '/docs-index.json')).json();
    const key = path.resolve(ROOT, 'docs');
    check(typeof idx.docsDirAbs === 'string' && path.isAbsolute(idx.docsDirAbs) &&
      path.resolve(idx.docsDirAbs) === key,
      'docs-index.json 带 docsDirAbs（文档目录绝对路径）', String(idx.docsDirAbs));

    // 1. 空文件时 GET 返回 {}
    fs.rmSync(BOOK, { force: true });
    const empty = await fetch(base + '/api/bookmarks');
    const emptyObj = await empty.json();
    check(empty.status === 200 && emptyObj && typeof emptyObj === 'object' && !Array.isArray(emptyObj) &&
      Object.keys(emptyObj).length === 0, '空文件时 GET /api/bookmarks 返回 {}', String(empty.status));

    // 2. 书签：按章节 toggle，写入即 add；杂物字段（ratio/junk）被丢掉
    const docA = 'docs/指南/界面与快捷键.md';
    let r = await post(base, {
      key,
      op: { op: 'bmk-toggle', path: docA, sec: '快捷键', secText: '快捷键', title: '界面与快捷键', ratio: 0.6, junk: 1 },
    });
    let out = await r.json();
    check(r.status === 200 && out.ok === true && out.action === 'add', 'bmk-toggle 首次 → add', JSON.stringify(out));
    let saved = disk()[key];
    check(saved.bookmarks.length === 1, 'bookmark.json 写入 1 条书签', JSON.stringify(saved));
    const bmk = saved.bookmarks[0];
    check(bmk.path === docA && bmk.sec === '快捷键' && bmk.secText === '快捷键' && bmk.title === '界面与快捷键' && bmk.at,
      '书签记录含 path / sec / secText / title / at', JSON.stringify(bmk));
    check(!('ratio' in bmk) && !('junk' in bmk), '书签不保存 ratio / 未知字段', JSON.stringify(bmk));
    check(!fs.existsSync(BOOK + '.tmp'), '没有留下 bookmark.json.tmp（原子写）');

    // 3. 同一节再 toggle → 取消；删空后 key 消失
    r = await post(base, { key, op: { op: 'bmk-toggle', path: docA, sec: '快捷键', secText: '快捷键' } });
    out = await r.json();
    check(out.action === 'remove' && !(key in disk()), '同一章节再次 toggle → 取消，空条目从文件删除', JSON.stringify(out));

    // 4. 一篇文档可以记多节书签
    for (const [sec, text] of [['快捷键', '快捷键'], ['侧栏宽度的实现要点', '侧栏宽度的实现要点'], ['全文搜索的实现要点', '全文搜索的实现要点']]) {
      await post(base, { key, op: { op: 'bmk-toggle', path: docA, sec, secText: text, title: '界面与快捷键' } });
    }
    saved = disk()[key];
    check(saved.bookmarks.length === 3 && saved.bookmarks.every((x) => x.path === docA),
      '同一篇文档可记多条（按章节）', JSON.stringify(saved.bookmarks.map((x) => x.sec)));

    // 5. 按 (path, sec) 删一条，其它不动；删不存在的返回 none
    r = await post(base, { key, op: { op: 'bmk-remove', path: docA, sec: '侧栏宽度的实现要点' } });
    out = await r.json();
    saved = disk()[key];
    check(out.action === 'remove' && saved.bookmarks.length === 2 &&
      !saved.bookmarks.some((x) => x.sec === '侧栏宽度的实现要点'), 'bmk-remove 只删指定章节', JSON.stringify(saved.bookmarks.map((x) => x.sec)));
    r = await post(base, { key, op: { op: 'bmk-remove', path: docA, sec: '不存在的章节' } });
    out = await r.json();
    check(out.action === 'none' && disk()[key].bookmarks.length === 2, '删除不存在的书签 → none，数据不变', JSON.stringify(out));

    // 6. 收藏：整篇一条，toggle 加/删
    r = await post(base, { key, op: { op: 'fav-toggle', path: docA, title: '界面与快捷键' } });
    out = await r.json();
    saved = disk()[key];
    check(out.action === 'add' && saved.favs.length === 1 && saved.favs[0].path === docA,
      'fav-toggle 首次 → add', JSON.stringify(saved.favs));
    r = await post(base, { key, op: { op: 'fav-toggle', path: docA, title: '界面与快捷键' } });
    out = await r.json();
    check(out.action === 'remove' && disk()[key].favs.length === 0, 'fav-toggle 再次 → 取消', JSON.stringify(out));
    r = await post(base, { key, op: { op: 'fav-remove', path: docA } });
    out = await r.json();
    check(out.action === 'none', '删除不存在的收藏 → none', JSON.stringify(out));

    // 7. GET 读到的就是最新数据
    const got = await getBook(base);
    check(got[key] && got[key].bookmarks.length === 2, 'GET 能读回当前条目', JSON.stringify(got[key] && got[key].bookmarks.length));

    // 8. 旧数据归一化：没有 sec 的旧书签、ratio 字段在读取时被清掉
    const legacy = {
      [key]: {
        favs: [{ path: docA, title: '界面与快捷键', at: '2026-10-01T00:00:00.000Z' }],
        bookmarks: [
          { path: docA, title: '界面与快捷键', at: '2026-10-01T00:00:00.000Z', sec: '', secText: '', ratio: 0.4 },
          { path: docA, title: '界面与快捷键', at: '2026-10-01T00:00:00.000Z', sec: '快捷键', secText: '快捷键', ratio: 0.7 },
        ],
      },
    };
    fs.writeFileSync(BOOK, JSON.stringify(legacy, null, 2) + '\n', 'utf8');
    const norm = await getBook(base);
    check(norm[key].bookmarks.length === 1 && norm[key].bookmarks[0].sec === '快捷键' &&
      !('ratio' in norm[key].bookmarks[0]), '旧数据读取时丢掉无章节书签与 ratio', JSON.stringify(norm[key].bookmarks));
    check(fs.readFileSync(BOOK, 'utf8').includes('"ratio"'), 'GET 只归一化返回，不改磁盘（等下一次操作再落盘）');
    await post(base, { key, op: { op: 'fav-toggle', path: 'docs/指南/快速开始.md', title: '快速开始' } });
    check(!fs.readFileSync(BOOK, 'utf8').includes('"ratio"'), '下一次操作落盘时文件被归一化');

    // 9. 坏请求：非法 JSON / 缺 key / 不认识的 op / 方法不对
    const badJson = await post(base, '{ not json');
    check(badJson.status === 400, '非法 JSON → 400', String(badJson.status));
    const noKey = await post(base, { op: { op: 'fav-toggle', path: docA } });
    check(noKey.status === 400, '缺 key → 400', String(noKey.status));
    const badOp = await post(base, { key, op: { op: 'drop-everything' } });
    check(badOp.status === 400, '不认识的 op → 400', String(badOp.status));
    const del = await fetch(base + '/api/bookmarks', { method: 'DELETE' });
    check(del.status === 405, 'DELETE → 405', String(del.status));

    // 10. 用户数据不进静态资源
    const raw = await fetch(base + '/bookmark.json');
    check(raw.status === 403, 'GET /bookmark.json → 403', String(raw.status));

    // 11. 页面里确实有导航入口、浮动按钮与目录书签图标样式
    const page = await (await fetch(base + '/index.html')).text();
    check(page.includes('id="favNav"') && page.includes('id="bmkNav"') && page.includes('id="favBtn"') &&
      page.includes('id="bmkBtn"') && page.includes('class="float-tools"'),
      '实时版页面包含顶栏导航与右下角按钮组');
  } finally {
    proc.kill();
    await sleep(300);
  }
}

try {
  await run();
  console.log(fail ? `\n===== 失败 ${fail} 项 =====` : '\n===== 全部通过 =====');
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error('x ' + (e && e.stack || e));
  process.exitCode = 1;
} finally {
  if (backup === null) { try { fs.rmSync(BOOK, { force: true }); } catch (e) {} }
  else { try { fs.writeFileSync(BOOK, backup); } catch (e) {} }
}
