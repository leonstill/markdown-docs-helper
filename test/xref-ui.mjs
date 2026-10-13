/* =====================================================================
 * 跨文档章节引用界面回归（无头 Chrome + CDP）
 *
 * 覆盖「父文档 §4.1」这类引用在真实页面里的行为：
 *   · 文首声明渲染成「引用目标」徽标，声明行不进正文、也不污染左栏摘要
 *   · 「父文档 §4.3」跳到父文档的 4.3（而不是本文档的 4.3），落点标题会闪一下
 *   · 「`docs/父文档.md` §1.1」零声明写法同样跳对
 *   · 目标文档里没有该编号时降级：跳到目标文档顶部 + class=missing
 *   · 裸 §4.3 仍然指本文档
 *
 * 做法：自己搭一个临时文档目录（不动仓库里的 docs/）起 --serve，跑完收尾：
 *       关浏览器、关服务、删临时目录。--serve 不写任何产物，
 *       md-viewer.html / docs-index.json 不会被临时目录顶掉，不用还原。
 *
 * 用法：node test/xref-ui.mjs      （失败退出码 1）
 *      环境变量 CHROME 可指定浏览器路径；沙箱里可能起不了浏览器（命名管道 IPC 被拦）。
 * ===================================================================== */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CDP_PORT = 9336;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error('x 找不到浏览器：' + CHROME + '\n  用环境变量 CHROME 指定路径。');
  process.exit(1);
}

/* ---------- 临时文档目录：父文档 + 引用它的子文档 ---------- */
const PARENT = `# 父文档

跨文档章节引用的目标文档。

## 1 总述

### 1.1 编号 1.1 的小节

这里是 1.1 的落点。

## 2 填充正文（让页面真的能滚动）

${Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 段填充文字，用来把 4.3 推到首屏下面，这样「跳到 4.3」才有可验证的滚动量。`).join('\n\n')}

## 4 验收

### 4.1 编号 4.1 的小节

这里是 4.1 的落点。

### 4.3 编号 4.3 的小节

这里是 4.3 的落点。

## 9 尾部填充（让 4.3 还能滚到顶部）

${Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 段尾部填充，保证 4.3 后面还有超过一屏的内容，否则页面到底就滚不上去了。`).join('\n\n')}
`;

const CHILD = `父文档指: \`docs/父文档.md\`
<!-- 总览: docs/父文档.md -->

# 子文档

本文验证「父文档 §4.1」跳到父文档，而不是本文档的同名编号。

## 4 本文自己的第四节

### 4.3 本文自己的 4.3（误跳的陷阱）

- 别名写法：父文档 §4.3 应当落到父文档的 4.3。
- 零声明写法：\`docs/父文档.md\` §1.1 靠路径直接指过去。
- 目标里没有这个编号：父文档 §9.9 应当降级为「跳父文档顶部」。
- 裸编号仍然指本文档：§4.3 跳到本文档的 4.3。
`;

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '   <- ' + (detail === undefined ? '' : detail)}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function waitJson(url, timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch (e) {}
    if (Date.now() - t0 > timeoutMs) throw new Error('等待超时: ' + url);
    await sleep(150);
  }
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method) this.events.push(m);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); } }, 30000);
    });
  }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  }
  async waitFor(expr, timeoutMs = 15000) {
    const t0 = Date.now();
    for (;;) {
      try { if (await this.ev(expr)) return true; } catch (e) {}
      if (Date.now() - t0 > timeoutMs) return false;
      await sleep(120);
    }
  }
  errors() {
    return this.events
      .filter((e) => e.method === 'Runtime.exceptionThrown' ||
        (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
        (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
      .map((e) => e.method === 'Runtime.exceptionThrown'
        ? 'exception: ' + (e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text)
        : e.method === 'Log.entryAdded' ? 'log: ' + e.params.entry.text
          : 'console.error: ' + (e.params.args || []).map((a) => a.value || a.description).join(' '))
      .filter((s) => !/favicon/i.test(s));
  }
}

/* 页面上按文字找引用链接：返回 { href, cls, title } */
const linkProbe = (text) => `(function(){
  var t = ${JSON.stringify(text)};
  var a = [].slice.call(document.querySelectorAll('#article a')).filter(function(x){
    return x.textContent.replace(/\\s+/g, ' ').trim() === t; })[0];
  return a ? { href: a.getAttribute('href'), cls: a.className, title: a.getAttribute('title') } : null;
})()`;

(async () => {
  const tmpDocs = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-xref-'));
  fs.writeFileSync(path.join(tmpDocs, '父文档.md'), PARENT);
  fs.writeFileSync(path.join(tmpDocs, '子文档.md'), CHILD);
  const profile = path.join(os.tmpdir(), 'mdh-xref-profile-' + Date.now());
  const serverPort = await freePort();
  const server = spawn(process.execPath, [path.join(ROOT, 'build-docs.mjs'), '--serve', tmpDocs, '--port', String(serverPort)],
    { cwd: ROOT, stdio: 'ignore' });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    await waitJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
    await waitJson(`http://127.0.0.1:${serverPort}/docs-index.json`);
    const list = await waitJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    cdp = new CDP(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable');

    /* 打开子文档 */
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/index.html#p=docs%2F%E5%AD%90%E6%96%87%E6%A1%A3.md` });
    if (!await cdp.waitFor(`!!document.querySelector('#article .docrefs')`)) {
      console.log('x 页面没渲染出「引用目标」徽标，后面的断言跳过');
      check('子文档已打开', false, 'location.hash=' + await cdp.ev('location.hash'));
    } else {
      check('子文档已打开', true);

      /* 1. 文首声明：变成徽标，不进正文 */
      const badges = await cdp.ev(`[].slice.call(document.querySelectorAll('#article .docrefs .dref')).map(function(a){
        return { text: a.textContent.replace(/\\s+/g, ' ').trim(), href: a.getAttribute('href'), broken: a.classList.contains('broken') }; })`);
      check('两条声明渲染成两个引用目标徽标', badges.length === 2, JSON.stringify(badges));
      check('徽标指向父文档', badges.every((b) => b.href === '#p=docs%2F%E7%88%B6%E6%96%87%E6%A1%A3.md' && !b.broken),
        JSON.stringify(badges));
      check('徽标显示别名与目标标题', /父文档 → 父文档/.test(badges[0].text) && /总览 → 父文档/.test(badges[1].text),
        JSON.stringify(badges.map((b) => b.text)));
      const bodyText = await cdp.ev(`document.querySelector('#article').textContent`);
      check('声明行不进正文', !bodyText.includes('父文档指') && !bodyText.includes('<!--'), bodyText.slice(0, 80));

      /* 2. 左栏摘要不被声明行污染 */
      const summary = await cdp.ev(`(function(){
        var a = [].slice.call(document.querySelectorAll('#tree .docitem')).filter(function(x){
          return x.getAttribute('href').indexOf('%E5%AD%90%E6%96%87%E6%A1%A3') >= 0; })[0];
        return a ? a.querySelector('.s').textContent.trim() : null; })()`);
      check('左栏摘要取正文首句而不是声明行', !!summary && !summary.includes('父文档指'), summary);

      /* 3. 别名引用：跳到父文档的 4.3 */
      const aliasLink = await cdp.ev(linkProbe('父文档 §4.3'));
      check('「父文档 §4.3」是跨文档章节链接', !!aliasLink && /secref/.test(aliasLink.cls) && /xref/.test(aliasLink.cls),
        JSON.stringify(aliasLink));
      check('「父文档 §4.3」指向父文档', !!aliasLink && aliasLink.href.indexOf('#p=docs%2F%E7%88%B6%E6%96%87%E6%A1%A3.md&h=') === 0,
        aliasLink && aliasLink.href);

      const bareLink = await cdp.ev(linkProbe('§4.3'));
      check('裸 §4.3 仍指本文档', !!bareLink && bareLink.href.indexOf('#p=docs%2F%E5%AD%90%E6%96%87%E6%A1%A3.md&h=') === 0,
        bareLink && bareLink.href);
      check('跨文档链接与本文档链接不是同一个落点', !!aliasLink && !!bareLink && aliasLink.href !== bareLink.href);

      /* 点击后等渲染完成：renderDoc 在 requestAnimationFrame 里滚动并给落点标题加 flash */
      await cdp.ev(`(function(){ var t = ${JSON.stringify('父文档 §4.3')};
        [].slice.call(document.querySelectorAll('#article a')).filter(function(x){
          return x.textContent.replace(/\\s+/g, ' ').trim() === t; })[0].click(); })()`);
      check('点击后跳到父文档的章节锚点',
        await cdp.waitFor(`/p=docs%2F%E7%88%B6%E6%96%87%E6%A1%A3\\.md&h=/.test(location.hash)`),
        await cdp.ev('location.hash'));
      check('落点标题闪一下（视觉确认）',
        await cdp.waitFor(`!!document.querySelector('#article .flash')`, 3000),
        await cdp.ev('location.hash'));
      const landing = await cdp.ev(`(function(){
        var el = document.querySelector('#article .flash');
        return { path: document.getElementById('docPath').textContent,
                 text: el ? el.textContent.replace(/^#/, '').replace(/\\s+/g, ' ').trim().slice(0, 5) : null,
                 inHash: el ? location.hash.indexOf('h=' + encodeURIComponent(el.id)) >= 0 : false,
                 top: el ? Math.round(el.getBoundingClientRect().top) : -1,
                 scrollY: Math.round(window.scrollY),
                 scrollable: document.documentElement.scrollHeight - window.innerHeight > 200 }; })()`);
      check('落点标题是父文档的 4.3', landing.text === '4.3 编' && landing.inHash, JSON.stringify(landing));
      check('真滚动了，且落点停在视口顶部附近',
        landing.scrollable && landing.scrollY > 100 && landing.top >= 0 && landing.top < 160,
        JSON.stringify(landing));
      check('页面切到父文档', /父文档\.md$/.test(String(landing.path)), landing.path);

      /* 4. 零声明写法 */
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/index.html#p=docs%2F%E5%AD%90%E6%96%87%E6%A1%A3.md` });
      await cdp.waitFor(`!!document.querySelector('#article .docrefs')`);
      const pathLink = await cdp.ev(linkProbe('docs/父文档.md §1.1'));
      check('「`docs/父文档.md` §1.1」跳到父文档', !!pathLink &&
        pathLink.href.indexOf('#p=docs%2F%E7%88%B6%E6%96%87%E6%A1%A3.md&h=') === 0 && /docref/.test(pathLink.cls),
        JSON.stringify(pathLink));

      /* 5. 兜底分支：目标里没有 §9.9 -> 跳目标文档顶部 + missing */
      const missLink = await cdp.ev(linkProbe('父文档 §9.9'));
      check('目标里没有的编号标成 missing', !!missLink && /missing/.test(missLink.cls) && /没有/.test(String(missLink.title)),
        JSON.stringify(missLink));
      check('missing 链接降级到父文档顶部（不带 h=）', !!missLink && missLink.href === '#p=docs%2F%E7%88%B6%E6%96%87%E6%A1%A3.md',
        missLink && missLink.href);
      await cdp.ev(`(function(){ var t = ${JSON.stringify('父文档 §9.9')};
        [].slice.call(document.querySelectorAll('#article a')).filter(function(x){
          return x.textContent.replace(/\\s+/g, ' ').trim() === t; })[0].click(); })()`);
      const topJump = await cdp.waitFor(`location.hash === '#p=docs%2F%E7%88%B6%E6%96%87%E6%A1%A3.md'`);
      check('点击 missing 链接跳到父文档顶部', topJump, await cdp.ev('location.hash'));
      check('跳转后停在文档顶部', await cdp.ev('window.scrollY') < 40, await cdp.ev('window.scrollY'));
    }

    const errs = cdp.errors();
    check('全程无 console 错误', errs.length === 0, errs.join(' | '));
  } catch (e) {
    check('用例执行未抛异常', false, e && e.message ? e.message : String(e));
  } finally {
    try { chrome.kill(); } catch (e) {}
    try { server.kill(); } catch (e) {}
    await sleep(300);
    try { fs.rmSync(tmpDocs, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
    /* --serve 不写任何产物，临时文档目录不会污染 md-viewer.html / docs-index.json，无需还原 */
  }

  const bad = results.filter((r) => !r.ok).length;
  console.log(bad ? `\n✗ ${bad} 项失败 / 共 ${results.length} 项` : `\n✓ 全部通过（${results.length} 项）`);
  process.exit(bad ? 1 : 0);
})();
