/* =====================================================================
 * 界面回归（无头 Chrome + CDP）
 *
 * 覆盖：默认状态、两侧栏开关与 ✕、书签列位置菜单、快捷键、状态记忆、窄屏抽屉与遮罩、
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
import { spawn, spawnSync } from 'node:child_process';
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
    brand: txt('#brandTitle'), sub: txt('#brandSub'), subHidden: document.getElementById('brandSub').hidden,
    sidebarTitle: txt('#sidebarTitle'), tocTitle: txt('#tocTitle'),
    homeHeading: txt('#article h1'),
    introLen: (document.querySelector('#article .intro')||{textContent:''}).textContent.trim().length,
    introHasList: !!document.querySelector('#article .intro ul'),
    cards: document.querySelectorAll('.card').length,
    docitems: document.querySelectorAll('#tree .docitem').length,
    /* .t 里除了标题还可能带「导图」小标记（思维导图条目），取标题时把它排除 */
    titles: [].slice.call(document.querySelectorAll('#tree .docitem .t')).map(function(e){
      var c = e.querySelector('.chip-mm'); if (c) c.remove();
      return e.textContent.trim();
    }),
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
  /* 产物只由构建命令生成（--serve 全程不写盘）：先显式构建一次，
     下面 file:// 要打开 md-viewer.html，期望值还要读 docs-index.json */
  spawnSync(process.execPath, [path.join(ROOT, 'build-docs.mjs')], { cwd: ROOT, stdio: 'ignore' });
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
  const indexJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs-index.json'), 'utf8'));
  const indexDocs = indexJson.docs;
  const normDir = (p) => String(p).replace(/\/+$/, '');
  /* 页面展示去掉 docs/ 虚拟前缀：顶层归「根目录」 */
  const dispDir = (dir) => (dir === 'docs' ? '.' : dir.replace(/^docs\//, ''));
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
    const shown = dir === '.' ? '.' : dispDir(dir);
    return (f && f.label) || (shown === '.' ? '根目录' : shown);
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
    check('首页 intro 与 config.json 一致', (p.introLen > 0) === !!String(embeddedCfg.home.intro || '').trim(),
      'len=' + p.introLen);
    check('首页卡片数 = 配置决定的可见文档数', p.cards === expDocs.length, 'cards=' + p.cards + ' 期望=' + expDocs.length);
    check('左栏分组名与 config 一致', sameSet(p.dirs, expDirLabels), '实际=' + p.dirs.join('|') + ' 期望=' + expDirLabels.join('|'));
    check('阅读宽度来自 config（' + (embeddedCfg.reading?.maxWidth || 920) + 'px）',
      p.cfgW === (embeddedCfg.reading?.maxWidth || 920) + 'px', p.cfgW);
    check('页脚提示 config.json 管理显示内容', /config\.json/.test(p.foot));
    check('无 console 错误', cdp.errors().length === 0, cdp.errors().join('; '));
    await cdp.shot('01-overview.png');

    console.log('\n--- A2. 品牌区：标题开菜单、副标题回首页 ---');
    check('有副标题时按钮可见', p.subHidden === false);
    await cdp.ev("document.getElementById('brandBtn').click()");
    await sleep(300);
    check('点标题打开帮助/关于菜单', await cdp.ev("!document.getElementById('brandMenu').hidden"));
    check('菜单项是帮助 + 关于…', await cdp.ev("document.querySelectorAll('#brandMenu .menu-item').length") === 2);
    await cdp.shot('01b-brand-menu.png');
    await cdp.ev("document.getElementById('brandSub').click()");
    await cdp.waitFor("document.querySelectorAll('.card').length>0");
    await sleep(400);
    p = await cdp.ev(PROBE);
    check('首页点副标题仍在首页、菜单收起', p.homeHeading === embeddedCfg.home.title &&
      await cdp.ev("document.getElementById('brandMenu').hidden"));
    if (!expDocs.length) {
      console.log('  · 跳过：没有可见文档可打开');
    } else {
      await cdp.ev("location.hash = '#p=' + encodeURIComponent(" + JSON.stringify(expDocs[0].path) + ")");
      await cdp.waitFor("(document.getElementById('docPath').textContent||'').length>0");
      await sleep(400);
      check('已打开文档页', await cdp.ev("location.hash.indexOf('p=') >= 0"));
      /* 书签列：默认挂在正文左侧、离文字 5px；顶栏那枚按钮的三选一菜单能关掉 / 换边 */
      const railGeom = "(function(){var r=document.getElementById('bmkRail'),a=document.getElementById('article');" +
        "var b=r.getBoundingClientRect(),ab=a.getBoundingClientRect(),cs=getComputedStyle(a);" +
        "return JSON.stringify({hidden:r.hidden,gapL:Math.round(ab.left+parseFloat(cs.paddingLeft)-b.right)," +
        "gapR:Math.round(b.left-(ab.right-parseFloat(cs.paddingRight)))});})()";
      const rg0 = JSON.parse(await cdp.ev(railGeom));
      check('书签列默认在正文左侧、离文字 5px', rg0.hidden === false && rg0.gapL === 5, JSON.stringify(rg0));
      await cdp.ev("document.getElementById('railBtn').click()");
      check('书签列菜单三项、勾在「文档左侧」', await cdp.ev("(function(){var m=document.getElementById('railMenu');" +
        "return !m.hidden && m.querySelectorAll('.menu-item').length===3 &&" +
        "document.querySelector('#railMenu [data-rail=\"left\"]').getAttribute('aria-checked')==='true';})()"));
      await cdp.ev("document.querySelector('#railMenu [data-rail=\"off\"]').click()");
      await sleep(250);
      check('选「关闭」后书签列收起、菜单跟着关', JSON.parse(await cdp.ev(railGeom)).hidden === true &&
        await cdp.ev("document.getElementById('railMenu').hidden"));
      await cdp.ev("document.getElementById('railBtn').click()");
      await cdp.ev("document.querySelector('#railMenu [data-rail=\"right\"]').click()");
      await sleep(250);
      const rgR = JSON.parse(await cdp.ev(railGeom));
      check('选「文档右侧」后换到正文右边、离文字 5px', rgR.hidden === false && rgR.gapR === 5, JSON.stringify(rgR));
      await cdp.ev("document.getElementById('railBtn').click()");
      await cdp.ev("document.querySelector('#railMenu [data-rail=\"left\"]').click()");
      await sleep(250);
      check('选回「文档左侧」（恢复默认）', JSON.parse(await cdp.ev(railGeom)).gapL === 5);
      await cdp.ev("document.getElementById('brandSub').click()");
      await cdp.waitFor("document.querySelectorAll('.card').length>0");
      await sleep(400);
      p = await cdp.ev(PROBE);
      check('文档页点副标题回到首页', p.homeHeading === embeddedCfg.home.title && p.cards === expDocs.length,
        p.homeHeading + ' cards=' + p.cards);
      check('回首页后 hash 已清空', await cdp.ev("location.hash === '' || location.hash === '#'"));
    }

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
    check('窄屏隐藏副标题按钮', await cdp.ev("getComputedStyle(document.getElementById('brandSub')).display === 'none'"));
    await cdp.ev("document.getElementById('toggleLeft').click()");
    await sleep(500);
    s = await cdp.ev(PROBE);
    check('窄屏点开后左栏出现在视口内', s.leftHidden === false && s.sidebarLeft >= 0, 'left=' + s.sidebarLeft);
    check('窄屏抽屉打开时出现遮罩', s.scrimShown === true);
    await cdp.shot('04-narrow-drawer.png');

    console.log('\n--- F. 实时模式（http）---');
    p = await open(httpViewer, 1440, 1000);
    check('实时模式标识（页脚）', p.foot.includes('实时读取 ' + indexJson.docsDir), p.foot.slice(0, 80));
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
      mod.subtitle = '';
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
      check('副标题清空后按钮隐藏', p.subHidden === true, 'subHidden=' + p.subHidden);
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
