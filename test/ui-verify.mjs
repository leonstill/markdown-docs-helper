/* =====================================================================
 * 界面回归（无头 Chrome + CDP）
 *
 * 覆盖：默认状态、两侧栏开关与 ✕、快捷键、状态记忆、窄屏抽屉与遮罩、
 *       实时模式、config.json 改动即时生效、config 写错时的降级提示、
 *       以及全程无 console 错误。截图落在 test/shots/。
 *
 * 特点：脚本自己拉起一个 --serve 实例（端口自动挑空闲的），跑完自动关掉，
 *       所以不用先手工开服务。
 *
 * 用法：
 *   node test/ui-verify.mjs
 *   环境变量 CHROME 可指定浏览器路径（默认 Windows 上的 Chrome）
 * 注意：需要能启动浏览器；沙箱环境下可能被拒绝（命名管道 IPC 被拦）。
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
const CONFIG = path.join(ROOT, 'config.json');
const SHOTS = path.join(HERE, 'shots');
const CDP_PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error('x 找不到浏览器：' + CHROME + '\n  用环境变量 CHROME 指定路径。');
  process.exit(1);
}
fs.mkdirSync(SHOTS, { recursive: true });

const PROBE = `(function(){
  function txt(s){var e=document.querySelector(s);return e?e.textContent.replace(/\\s+/g,' ').trim():null;}
  var dirs=[].slice.call(document.querySelectorAll('#tree .dir')).map(function(e){
    return e.textContent.replace(/\\s*\\d+\\s*$/,'').trim();});
  return {
    leftHidden: document.body.classList.contains('left-hidden'),
    rightHidden: document.body.classList.contains('right-hidden'),
    sideOpen: document.body.classList.contains('side-open'),
    leftPressed: document.getElementById('toggleLeft').getAttribute('aria-pressed'),
    rightPressed: document.getElementById('toggleRight').getAttribute('aria-pressed'),
    brand: txt('#brandTitle'), sub: txt('#brandSub'),
    sidebarTitle: txt('#sidebarTitle'), tocTitle: txt('#tocTitle'),
    homeHeading: txt('#article h1'),
    introLen: (document.querySelector('#article .intro')||{textContent:''}).textContent.trim().length,
    introHasList: !!document.querySelector('#article .intro ul'),
    cards: document.querySelectorAll('.card').length,
    docitems: document.querySelectorAll('#tree .docitem').length,
    titles: [].slice.call(document.querySelectorAll('#tree .docitem .t')).map(function(e){return e.textContent.trim();}),
    dirs: dirs,
    notice: txt('#article .notice'),
    foot: txt('#foot'),
    searchShown: getComputedStyle(document.getElementById('searchWrap')).display !== 'none',
    cfgW: getComputedStyle(document.documentElement).getPropertyValue('--content-w').trim(),
    scrimShown: getComputedStyle(document.getElementById('scrim')).opacity === '1',
    sidebarLeft: (function(){var e=document.querySelector('.sidebar');return Math.round(e.getBoundingClientRect().left);})(),
    tocRight: (function(){var e=document.querySelector('.toc');return Math.round(e.getBoundingClientRect().right);})(),
    vw: window.innerWidth
  };
})()`;

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail === undefined ? '' : String(detail) });
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
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, file), Buffer.from(r.data, 'base64'));
    console.log(`    截图 shots/${file}  ${(fs.statSync(path.join(SHOTS, file)).size / 1024).toFixed(0)} KB`);
  }
  errors() {
    return this.events
      .filter((e) => e.method === 'Runtime.exceptionThrown' ||
        (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
        (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
      .map((e) => e.method === 'Runtime.exceptionThrown'
        ? 'exception: ' + (e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text)
        : e.method === 'Log.entryAdded' ? 'log: ' + e.params.entry.text + ' @' + (e.params.entry.url || '')
          : 'console.error: ' + (e.params.args || []).map((a) => a.value || a.description).join(' '))
      .filter((s) => !/favicon/i.test(s));
  }
}

(async () => {
  const profile = path.join(os.tmpdir(), 'mdh-ui-' + Date.now());
  const serverPort = await freePort();
  const httpViewer = `http://127.0.0.1:${serverPort}/`;
  const server = spawn(process.execPath, [path.join(ROOT, 'build-docs.mjs'), '--serve', '--port', String(serverPort)],
    { cwd: ROOT, stdio: 'ignore' });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore' });
  const originalConfig = fs.readFileSync(CONFIG, 'utf8');

  /* 期望值全部从「页面内置配置 + 文档索引」推导：换掉示例文档也不会误报 */
  const htmlText = fs.readFileSync(path.join(ROOT, 'md-viewer.html'), 'utf8');
  const embeddedCfg = JSON.parse(/<script id="viewer-config" type="application\/json">([\s\S]*?)<\/script>/.exec(htmlText)[1]);
  const indexDocs = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs-index.json'), 'utf8')).docs;
  const normDir = (p) => String(p).replace(/\/+$/, '');
  function expectedVisible(cfg) {
    let docs = indexDocs.slice();
    const ex = cfg.sidebar.exclude || [];
    if (ex.length) docs = docs.filter((d) => !ex.some((p) => { p = normDir(p); return d.path === p || d.path.indexOf(p + '/') === 0; }));
    const ov = cfg.sidebar.docs || {};
    docs = docs.map((d) => { const o = ov[d.path]; if (!o) return d; return o.hidden ? null : d; }).filter(Boolean);
    const folders = cfg.sidebar.folders || [];
    if (folders.length) {
      const allow = folders.map((f) => normDir(typeof f === 'string' ? f : f.dir));
      docs = docs.filter((d) => allow.some((a) => d.path.indexOf(a + '/') === 0));
    }
    return docs;
  }
  const expDocs = expectedVisible(embeddedCfg);
  const expDirs = [...new Set(expDocs.map((d) => {
    const i = d.path.lastIndexOf('/');
    return i < 0 ? '.' : d.path.slice(0, i);
  }))];
  const expDirLabels = expDirs.map((dir) => {
    const f = (embeddedCfg.sidebar.folders || []).find((x) => normDir(typeof x === 'string' ? x : x.dir) === dir);
    return (f && f.label) || (dir === '.' ? '根目录' : dir);
  });
  const sameSet = (a, b) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

  /* 场景 G 用「索引里篇数最多的那个分组」构造，不写死具体文档 */
  const groups = {};
  indexDocs.forEach((d) => { const i = d.path.lastIndexOf('/'); const dir = i < 0 ? '.' : d.path.slice(0, i); (groups[dir] = groups[dir] || []).push(d.path); });
  const scenDir = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length)[0];
  const scenDocs = scenDir ? groups[scenDir] : [];
  const hidePath = scenDocs[0], renamePath = scenDocs[1];

  console.log(`\n[基准] 内置 folders=${JSON.stringify(embeddedCfg.sidebar.folders)}`);
  console.log(`       预期可见 ${expDocs.length} 篇 / 分组 ${JSON.stringify(expDirLabels)}`);
  console.log(`       config 场景用分组 ${scenDir}（${scenDocs.length} 篇）`);

  try {
    await waitJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
    await waitJson(`http://127.0.0.1:${serverPort}/docs-index.json`);
    const list = await waitJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable');

    const viewer = 'file:///' + path.join(ROOT, 'md-viewer.html').replace(/\\/g, '/');

    async function open(url, w = 1440, h = 1100, clearStore = true) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
      await cdp.send('Page.navigate', { url });
      await cdp.waitFor("document.querySelectorAll('#tree .docitem').length>0 || document.querySelectorAll('.card').length>0");
      if (clearStore) {
        await cdp.ev("(function(){try{localStorage.clear()}catch(e){};return 1})()");
        await cdp.send('Page.reload', { ignoreCache: true });
        await cdp.waitFor("document.querySelectorAll('#tree .docitem').length>0 || document.querySelectorAll('.card').length>0");
      }
      await sleep(500);
      cdp.events.length = 0;
      return cdp.ev(PROBE);
    }

    console.log('\n--- A. 默认状态（file:// 快照模式）---');
    let p = await open(viewer);
    console.log('   ' + JSON.stringify({ left: p.leftHidden, right: p.rightHidden, brand: p.brand, sub: p.sub, home: p.homeHeading, cards: p.cards, dirs: p.dirs }));
    check('默认只开右侧栏（左隐藏、右显示）', p.leftHidden === true && p.rightHidden === false);
    check('开关按钮按下态与侧栏一致', p.leftPressed === 'false' && p.rightPressed === 'true');
    check('顶栏标题来自 config.json', p.brand === (embeddedCfg.title || ''), p.brand);
    check('副标题来自 config.json', p.sub === (embeddedCfg.subtitle || ''), p.sub);
    check('左栏标题来自 config.json', p.sidebarTitle === embeddedCfg.sidebar.title, p.sidebarTitle);
    check('首页标题来自 config.json', p.homeHeading === embeddedCfg.home.title, p.homeHeading);
    check('首页 intro 渲染为 Markdown', p.introLen > 50, 'len=' + p.introLen);
    check('首页卡片数 = 配置决定的可见文档数', p.cards === expDocs.length, 'cards=' + p.cards + ' 期望=' + expDocs.length);
    check('左栏分组名与 config 一致', sameSet(p.dirs, expDirLabels), '实际=' + p.dirs.join('|') + ' 期望=' + expDirLabels.join('|'));
    check('阅读宽度来自 config（' + (embeddedCfg.reading?.maxWidth || 920) + 'px）',
      p.cfgW === (embeddedCfg.reading?.maxWidth || 920) + 'px', p.cfgW);
    check('页脚提示 config.json 管理显示内容', /config\.json/.test(p.foot));
    check('无 console 错误', cdp.errors().length === 0, cdp.errors().join('; '));
    await cdp.shot('01-overview.png');

    console.log('\n--- B. 顶部开关 + 侧栏 ✕ ---');
    await cdp.ev("document.getElementById('toggleLeft').click()");
    await sleep(400);
    let s = await cdp.ev(PROBE);
    check('点左开关后左栏显示', s.leftHidden === false && s.leftPressed === 'true');
    await cdp.shot('02-left-open.png');
    await cdp.ev("document.getElementById('closeLeft').click()");
    await sleep(400);
    s = await cdp.ev(PROBE);
    check('点左栏 ✕ 后左栏隐藏', s.leftHidden === true);
    await cdp.ev("document.getElementById('closeRight').click()");
    await sleep(400);
    s = await cdp.ev(PROBE);
    check('点右栏 ✕ 后右栏隐藏', s.rightHidden === true);
    check('两栏都关时右栏不越界', s.tocRight <= s.vw);
    await cdp.shot('03-both-closed.png');
    await cdp.ev("document.getElementById('toggleRight').click()");
    await sleep(400);
    s = await cdp.ev(PROBE);
    check('点右开关恢复右栏', s.rightHidden === false && s.rightPressed === 'true');

    console.log('\n--- C. 记住上次状态 ---');
    await cdp.ev("document.getElementById('toggleLeft').click()");
    await sleep(400);
    await cdp.send('Page.reload', { ignoreCache: true });
    await cdp.waitFor("document.querySelectorAll('#tree .docitem').length>0");
    await sleep(600);
    s = await cdp.ev(PROBE);
    check('刷新后仍保持左栏打开状态', s.leftHidden === false, 'leftHidden=' + s.leftHidden);
    check('reload 后无 console 错误', cdp.errors().length === 0, cdp.errors().join('; '));

    console.log('\n--- D. 快捷键 [ ] ---');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '[', code: 'BracketLeft', text: '[' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '[', code: 'BracketLeft' });
    await sleep(400);
    check('按 [ 关闭左栏', (await cdp.ev(PROBE)).leftHidden === true);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ']', code: 'BracketRight', text: ']' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ']', code: 'BracketRight' });
    await sleep(400);
    check('按 ] 关闭右栏', (await cdp.ev(PROBE)).rightHidden === true);

    console.log('\n--- E. 窄屏（抽屉式，默认都收起）---');
    p = await open(viewer, 420, 860, false);
    console.log('   ' + JSON.stringify({ left: p.leftHidden, right: p.rightHidden, scrim: p.scrimShown, vw: p.vw }));
    check('窄屏默认两栏都收起', p.leftHidden === true && p.rightHidden === true);
    check('窄屏初始无遮罩', p.scrimShown === false);
    await cdp.ev("document.getElementById('toggleLeft').click()");
    await sleep(500);
    s = await cdp.ev(PROBE);
    check('窄屏点开后左栏出现在视口内', s.leftHidden === false && s.sidebarLeft >= 0, 'left=' + s.sidebarLeft);
    check('窄屏抽屉打开时出现遮罩', s.scrimShown === true);
    await cdp.shot('04-narrow-drawer.png');

    console.log('\n--- F. 实时模式（http）---');
    p = await open(httpViewer, 1440, 1000);
    check('实时模式标识（页脚）', /实时读取 docs\//.test(p.foot), p.foot.slice(0, 60));
    check('实时模式默认只开右栏', p.leftHidden === true && p.rightHidden === false);
    check('实时模式文档数与索引一致', p.docitems === expectedVisible(embeddedCfg).length, 'items=' + p.docitems);
    check('实时模式无 console 错误', cdp.errors().length === 0, cdp.errors().join('; '));

    console.log('\n--- G. 改 config.json 后刷新即生效（实时模式）---');
    if (scenDocs.length < 1) {
      console.log('  · 跳过：文档索引里没有可用分组');
    } else {
      const mod = JSON.parse(originalConfig.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));
      mod.home.title = '自定义首页标题';
      mod.home.intro = '## 测试引导\n\n这是 **临时** 内容。';
      mod.sidebar.folders = [{ dir: scenDir, label: '测试分组名' }];
      mod.sidebar.docs = {};
      if (hidePath) mod.sidebar.docs[hidePath] = { hidden: true };
      if (renamePath) mod.sidebar.docs[renamePath] = { title: '改名后的文档' };
      mod.toc.maxDepth = 2;
      mod.reading.maxWidth = 1040;
      const expAfter = expectedVisible({ sidebar: { folders: mod.sidebar.folders, exclude: [], docs: mod.sidebar.docs } });
      fs.writeFileSync(CONFIG, JSON.stringify(mod, null, 2), 'utf8');
      await cdp.send('Page.reload', { ignoreCache: true });
      await cdp.waitFor("document.querySelectorAll('#tree .docitem').length>0");
      await sleep(700);
      p = await cdp.ev(PROBE);
      check('首页标题被 config 改写', p.homeHeading === '自定义首页标题', p.homeHeading);
      check('intro 改成 Markdown 后正确渲染', p.introLen > 10, 'len=' + p.introLen);
      check('folders 白名单生效', sameSet(p.dirs, ['测试分组名']) && p.docitems === expAfter.length,
        p.dirs.join('|') + ' items=' + p.docitems + ' 期望=' + expAfter.length);
      if (hidePath) check('隐藏单篇生效', p.docitems === expAfter.length, 'items=' + p.docitems);
      if (renamePath) check('单篇改名生效', p.titles.some((t) => t === '改名后的文档'), 'titles=' + p.titles.join('|'));
      check('maxWidth 生效（1040px）', p.cfgW === '1040px', p.cfgW);
      check('首页卡片数与左栏一致', p.cards === expAfter.length, p.cards + ' vs ' + expAfter.length);
      await cdp.shot('05-config-applied.png');
    }

    console.log('\n--- H. config.json 写错时给出提示 ---');
    fs.writeFileSync(CONFIG, '{ "title": "坏的配置", ', 'utf8');
    await cdp.send('Page.reload', { ignoreCache: true });
    await cdp.waitFor("document.querySelectorAll('#tree .docitem').length>0");
    await sleep(700);
    p = await cdp.ev(PROBE);
    check('配置写错时首页显示红色提示', !!p.notice && /解析失败/.test(p.notice), p.notice);
    check('配置写错时回退内置配置（仍能正常显示）', p.cards === expDocs.length || p.docitems === expDocs.length,
      'cards=' + p.cards + ' items=' + p.docitems + ' 期望=' + expDocs.length);
    check('写错配置后仍无 console 异常', cdp.errors().length === 0, cdp.errors().join('; '));
    await cdp.shot('06-config-error.png');

    console.log('\n================ 汇总 ================');
    const failed = results.filter((r) => !r.ok);
    console.log(`共 ${results.length} 项断言，通过 ${results.length - failed.length}，失败 ${failed.length}`);
    failed.forEach((f) => console.log('  FAIL  ' + f.name + '  ' + f.detail));
    console.log(failed.length ? '===== 有失败 =====' : '===== 全部通过 =====');
    process.exitCode = failed.length ? 1 : 0;
    ws.close();
  } catch (e) {
    console.error('x ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(CONFIG, originalConfig, 'utf8');   // 还原用户配置
    chrome.kill();
    server.kill();
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
})();
