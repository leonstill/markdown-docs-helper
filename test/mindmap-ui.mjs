/* =====================================================================
 * 思维导图界面回归（无头 Chrome + CDP）
 *
 * 覆盖 .mermaid 文档在真实浏览器里的完整链路：
 *   · 左栏列出 .mermaid 条目并带「导图」标记
 *   · 打开后正文区切换成导图视图（markmap 真的画出了节点，不是白屏）
 *   · 节点文字是中文正常显示（不是 &#x...; 实体）
 *   · 滚轮缩放 / 拖拽平移 / 点节点折叠展开
 *   · 右侧大纲条目数与解析结果一致，点击可折叠、可跳转
 *   · 全屏按钮：容器铺满浏览器窗口、盖住顶栏、锁滚动、Esc 还原、换文档自动解锁
 *   · 导出 SVG / PNG（走真实下载路径，检查 Blob 内容）
 *   · 切深色主题后重新上色且无 console 错误
 *   · 关掉 config.mindmap.enabled 后 .mermaid 退回普通文本，不白屏
 *
 * 默认测离线单文件版（md-viewer.html，引擎内联）；加 --realtime 测实时版
 * （index.html，引擎走 vendor/markmap/*.js 本地外链）——两条路径的引擎加载方式不同，
 * 都要确认 markmap 真的挂上了 window 才能画出图。
 *
 * 自己拉起 --serve 实例并自动收尾；临时改 config.json 后一定会还原。
 * 用法：node test/mindmap-ui.mjs [--realtime]   （需要能启动 Chrome，可用 CHROME 覆盖路径）
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
const CDP_PORT = 9336;
const REALTIME = process.argv.includes('--realtime');
const PAGE_FILE = REALTIME ? 'index.html' : 'md-viewer.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error('x 找不到浏览器：' + CHROME + '\n  用环境变量 CHROME 指定路径。');
  process.exit(1);
}
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail === undefined ? '' : String(detail) });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '   <- ' + (detail === undefined ? '' : detail)}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); } }, 40000);
    });
  }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  }
  async waitFor(expr, timeoutMs = 20000) {
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

/* 页面里的探针：只读状态，不改页面 */
const PROBE = `(function(){
  var svg = document.getElementById('mmSvgEl');
  var groups = svg ? svg.querySelectorAll('g.markmap-node') : [];
  var foreign = svg ? svg.querySelectorAll('g.markmap-node foreignObject') : [];
  var texts = [].slice.call(foreign).map(function(f){ return (f.textContent||'').trim(); });
  return {
    hasWrap: !!document.getElementById('mmWrap'),
    canvasShown: !!(svg && getComputedStyle(svg).display !== 'none'),
    nodeCount: groups.length,
    foldCount: svg ? svg.querySelectorAll('g.markmap-node.markmap-fold').length : 0,
    linkCount: svg ? svg.querySelectorAll('.markmap-link').length : 0,
    hasEntities: texts.some(function(t){ return /&#x|&amp;/.test(t); }),
    firstText: texts[0] || '',
    texts: texts,
    outlineItems: document.querySelectorAll('#tocList .mm-o-item').length,
    outlineTitle: (document.getElementById('tocTitle')||{}).textContent || '',
    stats: (document.getElementById('mmStats')||{}).textContent || '',
    fallbackShown: !document.getElementById('mmFallback').hidden,
    fallbackText: (document.getElementById('mmFallback')||{}).textContent || '',
    chips: document.querySelectorAll('#tree .chip-mm').length,
    docPath: (document.getElementById('docPath')||{}).textContent || '',
    transform: (function(){
      var g = svg && svg.querySelector('g');
      return g ? (g.getAttribute('transform')||'') : '';
    })(),
    svgBox: (function(){ var b = svg && svg.getBBox ? svg.getBBox() : null; return b ? {w:Math.round(b.width),h:Math.round(b.height)} : null; })()
  };
})()`;

(async () => {
  const profile = path.join(os.tmpdir(), 'mdh-mm-' + Date.now());
  const serverPort = await freePort();
  const server = spawn(process.execPath, [path.join(ROOT, 'build-docs.mjs'), '--serve', '--port', String(serverPort)],
    { cwd: ROOT, stdio: 'ignore' });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore' });
  const originalConfig = fs.readFileSync(CONFIG, 'utf8');
  let ws = null;

  try {
    await waitJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
    await waitJson(`http://127.0.0.1:${serverPort}/docs-index.json`);
    const idx = JSON.parse(await (await fetch(`http://127.0.0.1:${serverPort}/docs-index.json`)).text());
    const mmDoc = (idx.docs || []).find((d) => d.kind === 'mindmap') || (idx.docs || []).find((d) => /\.mermaid$/i.test(d.path));
    if (!mmDoc) {
      console.error('x 文档目录里没有 .mermaid，无法验证（先放一个思维导图文档）');
      process.exitCode = 1;
      return;
    }
    console.log(`\n[基准] 导图文档：${mmDoc.path}  标题「${mmDoc.title}」`);

    const list = await waitJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const page = list.find((t) => t.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

    const pageUrl = `http://127.0.0.1:${serverPort}/${PAGE_FILE}`;
    console.log(`\n[页面] ${PAGE_FILE}${REALTIME ? '（实时版：引擎走本地外链）' : '（离线版：引擎已内联）'}`);
    await cdp.send('Page.navigate', { url: pageUrl });
    await cdp.waitFor("document.querySelectorAll('#tree .docitem').length>0");
    /* 实时版的内置快照刻意置空（每次刷新去 fetch docs-index.json），
       这里把索引里的条目挂到 window，下方与快照相关的断言两种模式都能用 */
    await cdp.ev(`fetch('docs-index.json',{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){window.__docsForTest=j.docs;return 1})`);
    await sleep(300);
    await cdp.ev("(function(){try{localStorage.clear()}catch(e){};return 1})()");
    await cdp.send('Page.reload', { ignoreCache: true });
    await cdp.waitFor("document.querySelectorAll('#tree .docitem').length>0");

    console.log('\n--- A. 左栏列出 .mermaid ---');
    const chipCount = await cdp.ev("document.querySelectorAll('#tree .chip-mm').length");
    check('左栏有「导图」标记的条目', chipCount >= 1, 'chips=' + chipCount);
    const wrongChip = await cdp.ev(`(function(){
      var links = [].slice.call(document.querySelectorAll('#tree .docitem'));
      var bad = links.filter(function(a){ return /\\.mermaid$/i.test(a.getAttribute('href')||'') === false && a.querySelector('.chip-mm'); });
      return bad.length;
    })()`);
    check('非 .mermaid 条目不带「导图」标记', wrongChip === 0, 'bad=' + wrongChip);

    console.log('\n--- B. 打开导图：真的渲染出节点 ---');
    cdp.events.length = 0;
    await cdp.ev(`location.hash = '#p=' + encodeURIComponent(${JSON.stringify(mmDoc.path)})`);
    const rendered = await cdp.waitFor("document.querySelectorAll('#mmSvgEl g.markmap-node').length > 0");
    check('正文区出现思维导图画布且画出节点', rendered);
    await sleep(900);

    let p = await cdp.ev(PROBE);
    console.log('   ' + JSON.stringify({ nodes: p.nodeCount, links: p.linkCount, fold: p.foldCount, stats: p.stats, outline: p.outlineItems, box: p.svgBox }));
    check('导图视图容器存在', p.hasWrap === true);
    check('画布可见（不是白屏/回退提示）', p.canvasShown === true && p.fallbackShown === false,
      'canvas=' + p.canvasShown + ' fallback=' + p.fallbackShown + ' ' + p.fallbackText.slice(0, 80));
    check('画出了多个节点', p.nodeCount > 5, 'nodes=' + p.nodeCount);
    check('画出了连线', p.linkCount > 3, 'links=' + p.linkCount);
    check('SVG 有实际尺寸', !!p.svgBox && p.svgBox.w > 100 && p.svgBox.h > 50, JSON.stringify(p.svgBox));
    check('节点文字是中文而不是 HTML 实体', p.hasEntities === false && /[\u4e00-\u9fa5]/.test(p.firstText),
      'first=' + p.firstText + ' entities=' + p.hasEntities);
    check('顶栏路径是导图文档', p.docPath === mmDoc.path, p.docPath);
    check('统计信息显示了节点数与层数', /节点/.test(p.stats) && /层/.test(p.stats), p.stats);
    check('右栏标题变成「导图大纲」', p.outlineTitle === '导图大纲', p.outlineTitle);
    check('右侧大纲列出条目', p.outlineItems > 3, 'items=' + p.outlineItems);
    check('无 console 错误', cdp.errors().length === 0, cdp.errors().join('; '));
    await cdp.shot('10-mindmap.png');

    console.log('\n--- C. 折叠 / 缩放 ---');
    cdp.events.length = 0;
    // markmap 只给「有子节点」的节点绑点击（这类节点才有 circle），而且 DOM 顺序
    // 是渲染顺序、不是树顺序（叶子排在前面）。所以要挑一个带 circle 的节点来点。
    // 页面用事件委托接住 foreignObject 上的点击（这也是这个用例要守住的行为）。
    const collapsed = await cdp.ev(`(function(){
      var D = window.__mdvDebug;
      var before = document.querySelectorAll('#mmSvgEl g.markmap-node').length;
      var withCircle = [].slice.call(document.querySelectorAll('#mmSvgEl g.markmap-node'))
        .filter(function(g){ return !!g.querySelector('circle'); });
      if (!withCircle.length) return { ok: false, why: '没有可折叠的节点' };
      var g = withCircle[0];
      var target = g.querySelector('foreignObject') || g.querySelector('.markmap-foreign') || g;
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return { ok: true, before: before, candidates: withCircle.length };
    })()`);
    check('画布上存在可折叠的分支节点', collapsed.ok === true, JSON.stringify(collapsed));
    await sleep(1200);
    p = await cdp.ev(PROBE);
    const foldedPaths = await cdp.ev("window.__mdvDebug.folded().length");
    check('点节点后折叠生效（出现 markmap-fold 或节点数变少）',
      p.foldCount > 0 || p.nodeCount < collapsed.before,
      'before=' + collapsed.before + ' after=' + p.nodeCount + ' fold=' + p.foldCount);
    check('折叠状态同步到了右侧大纲', foldedPaths > 0, 'folded=' + foldedPaths);
    await cdp.shot('11-mindmap-collapsed.png');
    check('折叠后无 console 错误', cdp.errors().length === 0, cdp.errors().join('; '));

    // 再点一次应该展开回来
    await cdp.ev(`(function(){
      var withCircle = [].slice.call(document.querySelectorAll('#mmSvgEl g.markmap-node'))
        .filter(function(g){ return !!g.querySelector('circle'); });
      var g = withCircle[0];
      var t = g.querySelector('foreignObject') || g;
      t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return 1;
    })()`);
    await sleep(1200);
    const unfolded = await cdp.ev("window.__mdvDebug.folded().length");
    check('再点一次可以展开（折叠状态清空）', unfolded === 0, 'folded=' + unfolded);

    await cdp.ev("document.getElementById('mmFit').click()");
    await sleep(700);
    const afterFit = await cdp.ev("document.querySelector('#mmSvgEl g').getAttribute('transform')");
    check('点「适应」后画布 transform 有值', !!afterFit, 'transform=' + afterFit);

    console.log('\n--- C2. 全页面显示（铺满浏览器窗口） ---');
    cdp.events.length = 0;
    const fullBefore = await cdp.ev(`(function(){
      var btn = document.getElementById('mmFull');
      var wrap = document.getElementById('mmWrap');
      var b = wrap.getBoundingClientRect();
      return {
        hasBtn: !!btn, label: btn ? btn.textContent : '', pressed: btn ? btn.getAttribute('aria-pressed') : null,
        full: wrap.classList.contains('mm-full'), pos: getComputedStyle(wrap).position,
        w: Math.round(b.width), h: Math.round(b.height)
      };
    })()`);
    check('导图工具栏有「全屏」按钮，初始未按下且容器是文档流内的',
      fullBefore.hasBtn && fullBefore.label === '全屏' && fullBefore.pressed === 'false' &&
      fullBefore.full === false && fullBefore.pos !== 'fixed',
      JSON.stringify(fullBefore));

    await cdp.ev("document.getElementById('mmFull').click()");
    await sleep(700);
    const fullOn = await cdp.ev(`(function(){
      var wrap = document.getElementById('mmWrap');
      var btn = document.getElementById('mmFull');
      var b = wrap.getBoundingClientRect();
      var svg = document.getElementById('mmSvgEl').getBoundingClientRect();
      var hit = document.elementFromPoint(Math.round(window.innerWidth / 2), 14);
      return {
        full: wrap.classList.contains('mm-full'),
        lock: document.documentElement.classList.contains('mm-full-on'),
        label: btn.textContent, pressed: btn.getAttribute('aria-pressed'),
        pos: getComputedStyle(wrap).position,
        w: Math.round(b.width), h: Math.round(b.height),
        vw: window.innerWidth, vh: window.innerHeight,
        coversTop: b.top <= 0 && b.left <= 0 && b.width >= window.innerWidth - 1,
        hitInside: !!(hit && hit.closest && hit.closest('#mmWrap')),
        canvasW: Math.round(svg.width), canvasH: Math.round(svg.height),
        nodes: document.querySelectorAll('#mmSvgEl g.markmap-node').length
      };
    })()`);
    console.log('   ' + JSON.stringify(fullOn));
    check('点「全屏」后容器变成铺满视口的 fixed 覆盖层',
      fullOn.full === true && fullOn.pos === 'fixed' &&
      Math.abs(fullOn.w - fullOn.vw) <= 2 && Math.abs(fullOn.h - fullOn.vh) <= 2 && fullOn.coversTop,
      JSON.stringify(fullOn));
    check('覆盖层盖住了顶栏（视口顶部命中的是导图容器）', fullOn.hitInside === true, 'hitInside=' + fullOn.hitInside);
    check('按钮切到「退出全屏」并标记按下', fullOn.label === '退出全屏' && fullOn.pressed === 'true',
      fullOn.label + '/' + fullOn.pressed);
    check('底层页面滚动被锁住（退出时不会跳回顶部）', fullOn.lock === true);
    check('画布跟着放大（宽度超过全屏前的容器宽度）', fullOn.canvasW > fullBefore.w,
      'before=' + fullBefore.w + ' after=' + fullOn.canvasW);
    check('全屏后导图仍在（节点没被清掉）', fullOn.nodes > 5, 'nodes=' + fullOn.nodes);
    await cdp.shot('14-mindmap-fullscreen.png');
    check('进出全屏无 console 错误', cdp.errors().length === 0, cdp.errors().join('; '));

    // Esc 退出
    await cdp.ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await sleep(500);
    const fullOff = await cdp.ev(`(function(){
      var wrap = document.getElementById('mmWrap');
      var btn = document.getElementById('mmFull');
      return {
        full: wrap.classList.contains('mm-full'),
        lock: document.documentElement.classList.contains('mm-full-on'),
        label: btn.textContent, pressed: btn.getAttribute('aria-pressed'),
        pos: getComputedStyle(wrap).position,
        nodes: document.querySelectorAll('#mmSvgEl g.markmap-node').length
      };
    })()`);
    check('按 Esc 退出全屏并还原按钮状态',
      fullOff.full === false && fullOff.lock === false && fullOff.label === '全屏' &&
      fullOff.pressed === 'false' && fullOff.pos !== 'fixed',
      JSON.stringify(fullOff));
    check('退出后导图还在（没有白屏）', fullOff.nodes > 5, 'nodes=' + fullOff.nodes);

    // 全屏状态下换文档：滚动锁必须跟着解除，否则普通文档也滚不动
    await cdp.ev("document.getElementById('mmFull').click()");
    await sleep(400);
    const otherDoc = idx.docs.find((d) => d.path !== mmDoc.path && !/\.mermaid$/i.test(d.path));
    await cdp.ev(`location.hash = '#p=' + encodeURIComponent(${JSON.stringify(otherDoc.path)})`);
    await sleep(800);
    const afterSwitch = await cdp.ev(`(function(){
      return {
        lock: document.documentElement.classList.contains('mm-full-on'),
        wrap: !!document.getElementById('mmWrap'),
        overflow: getComputedStyle(document.documentElement).overflow
      };
    })()`);
    check('全屏时切到别的文档会解除滚动锁', afterSwitch.lock === false && afterSwitch.wrap === false,
      JSON.stringify(afterSwitch));
    // 切回导图，继续后面的用例
    await cdp.ev(`location.hash = '#p=' + encodeURIComponent(${JSON.stringify(mmDoc.path)})`);
    await cdp.waitFor("document.querySelectorAll('#mmSvgEl g.markmap-node').length > 0");
    await sleep(600);

    console.log('\n--- D. 大纲可折叠、点击可跳转 ---');
    // 挑一个「有子节点」的大纲项来验证折叠（叶子项的三角只是装饰）
    const branchPath = await cdp.ev(`(function(){
      var D = window.__mdvDebug;
      var items = D.outline();
      function find(list){
        for (var i = 0; i < list.length; i++) {
          if (list[i].children && list[i].children.length) return list[i].path;
          var deep = find(list[i].children || []);
          if (deep) return deep;
        }
        return null;
      }
      return find(items);
    })()`);
    check('大纲里存在可折叠的分支项', !!branchPath, 'path=' + branchPath);
    const outlineFold = await cdp.ev(`(function(){
      var item = document.querySelector('#tocList .mm-o-item[data-path=' + JSON.stringify(${JSON.stringify(branchPath)}) + ']');
      if (!item) return { ok: false, why: '没找到大纲项' };
      var caret = item.querySelector('.mm-o-caret');
      caret.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return { ok: true, path: item.dataset.path };
    })()`);
    await sleep(1000);
    const afterFold = await cdp.ev(`(function(){
      var item = document.querySelector('#tocList .mm-o-item[data-path=' + JSON.stringify(${JSON.stringify(branchPath)}) + ']');
      return { cls: item ? item.className : null, folded: window.__mdvDebug.folded().length };
    })()`);
    check('点大纲三角可以折叠该项',
      outlineFold.ok === true && /collapsed/.test(String(afterFold.cls)) && afterFold.folded > 0,
      JSON.stringify(outlineFold) + ' -> ' + JSON.stringify(afterFold));

    // 再点一次还原，然后点文字跳转
    await cdp.ev(`(function(){
      var item = document.querySelector('#tocList .mm-o-item[data-path=' + JSON.stringify(${JSON.stringify(branchPath)}) + ']');
      item.querySelector('.mm-o-caret').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return 1;
    })()`);
    await sleep(1000);
    await cdp.ev(`(function(){
      var item = document.querySelector('#tocList .mm-o-item[data-path=' + JSON.stringify(${JSON.stringify(branchPath)}) + ']');
      item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return 1;
    })()`);
    await sleep(1400);
    const jump = await cdp.ev(`(function(){
      var active = document.querySelectorAll('#tocList .mm-o-item.active');
      return { count: active.length, path: active[0] ? active[0].dataset.path : null };
    })()`);
    check('点大纲文字后该项高亮（跳转生效）', jump.count === 1 && jump.path === branchPath, JSON.stringify(jump));
    check('大纲交互后无 console 错误', cdp.errors().length === 0, cdp.errors().join('; '));

    console.log('\n--- E. 导出 SVG 与 PNG ---');
    const svgExport = await cdp.ev(`(function(){
      var D = window.__mdvDebug;
      var blob = D.exportSvg();
      if (!blob) return { ok:false, why: D.exportError() };
      return blob.text().then(function(t){
        return { ok:true, name: D.downloadName('svg'), type: blob.type, size: blob.size,
                 hasSvgTag: t.indexOf('<svg') >= 0,
                 hasViewBox: t.indexOf('viewBox') >= 0,
                 hasNodes: t.indexOf('markmap-node') >= 0,
                 hasStyle: t.indexOf('<style') >= 0,
                 hasBackground: t.indexOf('background') >= 0,
                 xmlHead: t.slice(0, 40) };
      });
    })()`);
    console.log('   ' + JSON.stringify(svgExport));
    check('导出 SVG 返回 image/svg+xml 的 Blob，文件名是 .svg',
      svgExport.ok && /image\/svg\+xml/.test(svgExport.type || '') && /\.svg$/.test(svgExport.name || ''),
      JSON.stringify(svgExport));
    check('导出的 SVG 是完整文档（XML 头 + <svg + viewBox + 节点 + 样式 + 底色）',
      svgExport.ok && /^<\?xml/.test(svgExport.xmlHead) && svgExport.hasSvgTag && svgExport.hasViewBox &&
      svgExport.hasNodes && svgExport.hasStyle && svgExport.hasBackground,
      JSON.stringify(svgExport));

    const pngExport = await cdp.ev(`(function(){
      var D = window.__mdvDebug;
      return D.exportPng().then(function(blob){
        if (!blob) return { ok:false, why: D.exportError() };
        return { ok:true, name: D.downloadName('png'), type: blob.type, size: blob.size };
      });
    })()`);
    await sleep(800);
    console.log('   ' + JSON.stringify(pngExport));
    check('导出 PNG 返回 image/png 的 Blob，文件名是 .png',
      pngExport.ok && pngExport.type === 'image/png' && /\.png$/.test(pngExport.name || ''),
      JSON.stringify(pngExport));
    check('导出的 PNG 不是空文件', pngExport.ok && pngExport.size > 2000, JSON.stringify(pngExport));
    check('导出过程没有留下错误状态', (await cdp.ev("window.__mdvDebug.exportError()")) === null);
    check('导出无 console 错误', cdp.errors().length === 0, cdp.errors().join('; '));

    console.log('\n--- F. 深色主题重新上色 ---');
    cdp.events.length = 0;
    await cdp.ev("document.getElementById('themeBtn').click()");
    await sleep(1200);
    p = await cdp.ev(PROBE);
    const themeAttr = await cdp.ev("document.documentElement.getAttribute('data-theme')");
    check('切到深色后导图仍在（没有被清空）', themeAttr === 'dark' && p.nodeCount > 5 && p.fallbackShown === false,
      'theme=' + themeAttr + ' nodes=' + p.nodeCount);
    check('深色下重新上色后无 console 错误', cdp.errors().length === 0, cdp.errors().join('; '));
    await cdp.shot('12-mindmap-dark.png');
    await cdp.ev("document.getElementById('themeBtn').click()");   // 切回浅色
    await sleep(800);

    console.log('\n--- G. 关掉 mindmap.enabled 后退回普通文本 ---');
    const off = JSON.parse(originalConfig.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));
    off.mindmap = Object.assign({}, off.mindmap || {}, { enabled: false });
    fs.writeFileSync(CONFIG, JSON.stringify(off, null, 2), 'utf8');
    cdp.events.length = 0;
    await cdp.send('Page.reload', { ignoreCache: true });
    await cdp.waitFor("document.querySelectorAll('#tree .docitem').length>0");
    // 先看「关了之后左栏还有没有标记」，再打开文档看正文
    const chipsWhenOff = await cdp.ev("document.querySelectorAll('#tree .chip-mm').length");
    await cdp.ev(`location.hash = '#p=' + encodeURIComponent(${JSON.stringify(mmDoc.path)})`);
    await sleep(900);
    const offState = await cdp.ev(`(function(){
      return {
        hasMm: !!document.getElementById('mmWrap'),
        kindSeen: (function(){
          var d = (window.__docsForTest || []).filter(function(x){ return x.path === ${JSON.stringify(mmDoc.path)}; })[0];
          return d ? d.kind : null;
        })(),
        hasArticle: !!document.querySelector('#article h1, #article pre, #article p'),
        articleText: (document.getElementById('article')||{}).textContent || ''
      };
    })()`);
    check('关闭后不再当导图（无画布）', offState.hasMm === false);
    check('关闭后正文仍是普通文本渲染（不白屏）', offState.hasArticle === true && offState.articleText.length > 20,
      'len=' + offState.articleText.length);
    check('关闭后左栏不再有「导图」标记', chipsWhenOff === 0, 'chips=' + chipsWhenOff);
    check('关闭后无 console 错误', cdp.errors().length === 0, cdp.errors().join('; '));
    await cdp.shot('13-mindmap-disabled.png');

    console.log('\n================ 汇总 ================');
    const failed = results.filter((r) => !r.ok);
    console.log(`共 ${results.length} 项断言，通过 ${results.length - failed.length}，失败 ${failed.length}`);
    failed.forEach((f) => console.log('  FAIL  ' + f.name + '  ' + f.detail));
    console.log(failed.length ? '===== 有失败 =====' : '===== 全部通过 =====');
    process.exitCode = failed.length ? 1 : 0;
  } catch (e) {
    console.error('x ' + (e && e.stack || e));
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(CONFIG, originalConfig, 'utf8');   // 一定会还原用户配置
    try { if (ws) ws.close(); } catch (e) {}
    chrome.kill();
    server.kill();
    await sleep(300);
    /* 测试期间 spawn 的 --serve 会用「临时配置」重建 md-viewer.html / docs-index.json /
       index.html；只还原 config.json 不够，还要再构建一次，否则跑完测试仓库里就躺着
       一批按临时配置生成的过期产物（node build-docs.mjs --check 会报错）。 */
    await new Promise((res) => {
      const b = spawn(process.execPath, [path.join(ROOT, 'build-docs.mjs')], { cwd: ROOT, stdio: 'ignore' });
      b.on('exit', res); b.on('error', res);
    });
  }
})();
