/* =====================================================================
 * 嵌入 Mermaid 图表界面回归（无头 Chrome + CDP）
 *
 * 覆盖 ```mermaid 围栏在真实浏览器里的完整链路：
 *   · 每段围栏都变成一块图，真的画出了 SVG（不是白屏），块数与文档里的围栏数一致
 *   · 中文标签、组合状态、注释都正常显示（不是 HTML 实体、不是源码文本）
 *   · 语法写错的那一块：显示错误框 + 自动摊开源码，其它块不受影响
 *   · 工具栏：源码展开/收起、复制到剪贴板、导出 SVG（含底色与 viewBox）、全屏 + Esc 还原
 *   · 切深色主题后按新主题重画（mermaid 主题是画进 SVG 的）
 *   · .mermaid 里写 stateDiagram-v2：按「图表」渲染（左栏标记、右栏标题都跟着变），
 *     同时原来的 mindmap 文档仍按导图渲染（不许回退）
 *   · 关掉 config.mermaid.enabled 后围栏退回普通代码块，页面不白屏
 *
 * 默认测离线单文件版（md-viewer.html，引擎内联）；加 --realtime 测实时版
 * （index.html，引擎走 vendor/mermaid/mermaid.min.js 本地外链）。
 *
 * 自己拉起 --serve 实例并自动收尾；临时改 config.json 后一定会还原。
 * 用法：node test/mermaid-ui.mjs [--realtime]   （需要能启动 Chrome，可用 CHROME 覆盖路径）
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
const CDP_PORT = Number(process.env.CDP_PORT || 9338);
const REALTIME = process.argv.includes('--realtime');
const PAGE_FILE = REALTIME ? 'index.html' : 'md-viewer.html';
const DEMO_DOC = /Mermaid 图表\.md$/;
const DIAGRAM_DOC = /状态机示例\.mermaid$/;
const MINDMAP_DOC = /思维导图.*\.mermaid$/;
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
  async waitFor(expr, timeoutMs = 25000) {
    const t0 = Date.now();
    for (;;) {
      try { if (await this.ev(expr)) return true; } catch (e) {}
      if (Date.now() - t0 > timeoutMs) return false;
      await sleep(150);
    }
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, file), Buffer.from(r.data, 'base64'));
    console.log(`    截图 shots/${file}  ${(fs.statSync(path.join(SHOTS, file)).size / 1024).toFixed(0)} KB`);
  }
  /* mermaid 自己遇到语法错会往 console 打红字，本用例里是「预期内」的，单独放行 */
  errors(ignoreParse = true) {
    return this.events
      .filter((e) => e.method === 'Runtime.exceptionThrown' ||
        (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
        (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
      .map((e) => e.method === 'Runtime.exceptionThrown'
        ? 'exception: ' + (e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text)
        : e.method === 'Log.entryAdded' ? 'log: ' + e.params.entry.text + ' @' + (e.params.entry.url || '')
          : 'console.error: ' + (e.params.args || []).map((a) => a.value || a.description).join(' '))
      .filter((s) => !/favicon/i.test(s))
      .filter((s) => !(ignoreParse && /parse error|Parse error|No diagram type|Lexical error|mermaid/i.test(s)));
  }
}

/* 页面上「都画完了」的判据：每块都到了 ok / error（没有卡在 loading/pending） */
const READY = `(function(){
  var b = window.__mdvDebug ? window.__mdvDebug.mermaidBlocks() : [];
  return b.length > 0 && b.every(function(x){ return x.state === 'ok' || x.state === 'error'; });
})()`;

const SUMMARY = `(function(){
  var b = window.__mdvDebug.mermaidBlocks();
  return {
    count: b.length,
    ok: b.filter(function(x){ return x.state === 'ok'; }).length,
    errors: b.filter(function(x){ return x.state === 'error'; }).map(function(x){ return { index: x.index, msg: (x.error||'').slice(0,60) }; }),
    kinds: b.map(function(x){ return x.kind; }),
    labels: b.map(function(x){ return x.label; }).filter(function(v,i,a){ return a.indexOf(v) === i; }),
    withSvg: b.filter(function(x){ return !!document.querySelectorAll('.mg-block')[b.indexOf(x)].querySelector('.mg-host > svg'); }).length,
    boxes: b.map(function(x){
      var el = document.querySelectorAll('.mg-block')[b.indexOf(x)];
      var svg = el.querySelector('.mg-host > svg');
      var r = svg ? svg.getBoundingClientRect() : null;
      return r ? [Math.round(r.width), Math.round(r.height)] : null;
    }),
    showSrc: b.filter(function(x){ return x.showSource; }).length,
    barCount: document.querySelectorAll('.mg-block .mg-bar .mg-btn').length,
    firstText: (b[0] && b[0].text) || '',
    firstNodes: (b[0] && b[0].nodes) || 0,
    firstEdges: (b[0] && b[0].edges) || 0,
    tocItems: document.querySelectorAll('#tocList a[data-sec]').length,
    tocTitle: (document.getElementById('tocTitle') || {}).textContent || '',
    hasMmWrap: !!document.getElementById('mmWrap'),
    mmNodes: document.querySelectorAll('#mmSvgEl g.markmap-node').length,
    codeFences: document.querySelectorAll('#article pre.code > code.language-mermaid').length,
    mgBlocks: document.querySelectorAll('#article .mg-block').length,
    srcPreVisible: (function(){
      var pre = document.querySelector('.mg-block .mg-body > pre.code');
      return pre ? getComputedStyle(pre).display !== 'none' : null;
    })()
  };
})()`;

(async () => {
  const profile = path.join(os.tmpdir(), 'mdh-mg-' + Date.now());
  const serverPort = await freePort();
  /* 产物只由构建命令生成（--serve 全程不写盘）：先把要打开的页面构建出来 */
  spawnSync(process.execPath, [path.join(ROOT, 'build-docs.mjs')], { cwd: ROOT, stdio: 'ignore' });
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
    const docs = idx.docs || [];
    const demoDoc = docs.find((d) => DEMO_DOC.test(d.path));
    const diagramDoc = docs.find((d) => DIAGRAM_DOC.test(d.path));
    const mindmapDoc = docs.find((d) => MINDMAP_DOC.test(d.path));
    if (!demoDoc) {
      console.error('x 文档目录里没有「Mermaid 图表.md」，无法验证（先跑一次 node build-docs.mjs）');
      process.exitCode = 1;
      return;
    }
    console.log(`\n[基准] 图表文档：${demoDoc.path}  标题「${demoDoc.title}」`);
    if (diagramDoc) console.log(`[基准] .mermaid 图表文档：${diagramDoc.path}`);
    if (mindmapDoc) console.log(`[基准] .mermaid 导图文档：${mindmapDoc.path}`);

    /* 文档里到底有几段 ```mermaid 围栏：直接从服务端拿原文数一遍，避免把常数写死在测试里 */
    const rawUrl = `http://127.0.0.1:${serverPort}/docs/${demoDoc.path.replace(/^docs\//, '').split('/')
      .map(encodeURIComponent).join('/')}`;
    const rawText = await (await fetch(rawUrl)).text();
    const fenceCount = (rawText.match(/^ {0,3}(`{3,}|~{3,})[ \t]*(mermaid\b|\{\.?mermaid\})/gim) || []).length;
    console.log(`     文档里有 ${fenceCount} 段 Mermaid 围栏（含 1 段故意写错的）`);

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
    await cdp.ev("(function(){try{localStorage.clear()}catch(e){};return 1})()");
    await cdp.send('Page.reload', { ignoreCache: true });
    await cdp.waitFor("document.querySelectorAll('#tree .docitem').length>0");
    /* 复制按钮优先走 navigator.clipboard，无头环境下先替换成可控实现，才能断言真的传了源码 */
    await cdp.ev(`(function(){
      window.__copied = null;
      try {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: function(t){ window.__copied = String(t); return Promise.resolve(); } }
        });
      } catch (e) {}
      return 1;
    })()`);

    console.log('\n--- A. 打开文档：每段围栏都画成了图 ---');
    cdp.events.length = 0;
    await cdp.ev(`location.hash = '#p=' + encodeURIComponent(${JSON.stringify(demoDoc.path)})`);
    const ready = await cdp.waitFor(READY, 40000);
    check('所有图表块都画完了（没有卡在 loading）', ready);
    await sleep(600);
    let s = await cdp.ev(SUMMARY);
    console.log('   ' + JSON.stringify({ count: s.count, ok: s.ok, errors: s.errors, kinds: s.kinds, svg: s.withSvg, bar: s.barCount }));

    check('图表块数量与文档里的围栏数一致', s.count === fenceCount, `blocks=${s.count} fences=${fenceCount}`);
    check('只有那段故意写错的没画出来', s.ok === fenceCount - 1 && s.errors.length === 1, JSON.stringify(s.errors));
    check('错误块带上了 Mermaid 的报错信息', s.errors.length === 1 && s.errors[0].msg.length > 4, JSON.stringify(s.errors));
    check('错误块自动摊开了源码', s.showSrc === 1, 'showSrc=' + s.showSrc);
    check('每块都生成了 SVG', s.withSvg === s.ok, `withSvg=${s.withSvg} ok=${s.ok}`);
    check('SVG 有实际尺寸（不是 0 高）', s.boxes.filter(Boolean).every((b) => b[0] > 100 && b[1] > 40),
      JSON.stringify(s.boxes));
    check('第一块画出状态节点与转移', s.firstNodes >= 4 && s.firstEdges >= 4, `nodes=${s.firstNodes} edges=${s.firstEdges}`);
    check('认出了状态图版式', s.kinds[0] === 'statediagram-v2' && s.labels.some((l) => /状态图/.test(l)),
      JSON.stringify({ kinds: s.kinds.slice(0, 4), labels: s.labels }));
    check('图里是中文标签而不是实体', /[\u4e00-\u9fa5]/.test(s.firstText) && !/&#x|&amp;/.test(s.firstText), s.firstText.slice(0, 60));
    check('工具栏按钮都在（源码/复制/SVG/全屏 × 每块，含失败那块）', s.barCount === fenceCount * 4, 'buttons=' + s.barCount);
    check('渲染成功后源码默认收起', s.srcPreVisible === false);
    check('正文里的标题大纲仍正常（图表不影响 Markdown 解析）', s.tocItems >= 5, 'tocItems=' + s.tocItems);
    check('无 console 错误', cdp.errors().length === 0, cdp.errors().join('; '));
    await cdp.shot('30-mermaid-doc.png');

    console.log('\n--- B. 工具栏：源码 / 复制 / 导出 ---');
    cdp.events.length = 0;
    const toggle = await cdp.ev(`(function(){
      var block = document.querySelector('.mg-block');
      var btn = block.querySelector('[data-mg-act="src"]');
      btn.click();
      var on = { shown: block.classList.contains('mg-show-src'), text: btn.textContent,
                 visible: getComputedStyle(block.querySelector('.mg-body > pre.code')).display !== 'none' };
      btn.click();
      var off = { shown: block.classList.contains('mg-show-src'), text: btn.textContent,
                  visible: getComputedStyle(block.querySelector('.mg-body > pre.code')).display !== 'none' };
      return { on: on, off: off };
    })()`);
    check('点「源码」摊开源码（按钮变「隐藏源码」）',
      toggle.on.shown === true && toggle.on.visible === true && toggle.on.text === '隐藏源码', JSON.stringify(toggle.on));
    check('再点一次收起', toggle.off.shown === false && toggle.off.visible === false && toggle.off.text === '源码', JSON.stringify(toggle.off));

    const copied = await cdp.ev(`(function(){
      var block = document.querySelector('.mg-block');
      var want = block.querySelector('.mg-body > pre.code > code').textContent;
      block.querySelector('[data-mg-act="copy"]').click();
      /* 反馈是 writeText 的 then 里才改的（微任务），等一拍再读 */
      return new Promise(function(res){
        setTimeout(function(){
          res({ want: want.slice(0, 40), got: (window.__copied || '').slice(0, 40),
                same: window.__copied === want,
                feedback: block.querySelector('[data-mg-act="copy"]').textContent });
        }, 80);
      });
    })()`);
    check('点「复制」把该块的源码原样交给剪贴板',
      copied.same === true && /stateDiagram-v2/.test(copied.got), JSON.stringify(copied));
    check('复制后按钮给了「已复制」反馈', copied.feedback === '已复制', copied.feedback);

    const svgExport = await cdp.ev(`(function(){
      var blob = window.__mdvDebug.exportMermaidSvg(0);
      if (!blob) return { ok: false };
      return blob.text().then(function(t){
        return { ok: true, type: blob.type, size: blob.size,
                 xmlHead: t.slice(0, 30),
                 hasSvg: t.indexOf('<svg') >= 0,
                 hasViewBox: t.indexOf('viewBox') >= 0,
                 hasStyle: t.indexOf('<style') >= 0,
                 hasBg: /fill="#ffffff"/.test(t),
                 dashId: (t.match(/id="[^"]*"/) || [''])[0].slice(0, 24) };
      });
    })()`);
    console.log('   ' + JSON.stringify(svgExport));
    check('导出 SVG 是自包含文档（XML 头 + <svg + viewBox + 主题样式 + 白底）',
      svgExport.ok && /image\/svg\+xml/.test(svgExport.type || '') && svgExport.hasSvg &&
      svgExport.hasViewBox && svgExport.hasStyle && svgExport.hasBg, JSON.stringify(svgExport));

    console.log('\n--- C. 全屏与 Esc ---');
    cdp.events.length = 0;
    await cdp.ev(`document.querySelector('.mg-block [data-mg-act="full"]').click()`);
    await sleep(400);
    const full = await cdp.ev(`(function(){
      var el = document.querySelector('.mg-block.mg-full');
      var r = el ? el.getBoundingClientRect() : null;
      /* 图在窗口里「真的画出来多大」：内容 bbox 过一遍 getScreenCTM 换成屏幕像素。
         只量 svg 元素盒子不够——它可能撑满了，画面却缩在角落里。 */
      var svg = el ? el.querySelector('.mg-host > svg') : null;
      var drawn = null, avail = null, scale = null;
      if (svg) {
        try {
          var bb = svg.getBBox(), m = svg.getScreenCTM();
          var pts = [[bb.x,bb.y],[bb.x+bb.width,bb.y],[bb.x,bb.y+bb.height],[bb.x+bb.width,bb.y+bb.height]]
            .map(function(p){ return { x: m.a*p[0]+m.c*p[1]+m.e, y: m.b*p[0]+m.d*p[1]+m.f }; });
          var xs = pts.map(function(p){ return p.x; }), ys = pts.map(function(p){ return p.y; });
          drawn = [Math.round(Math.max.apply(null,xs)-Math.min.apply(null,xs)), Math.round(Math.max.apply(null,ys)-Math.min.apply(null,ys))];
          scale = [Math.round(m.a*1000)/1000, Math.round(m.d*1000)/1000];   // 等比缩放时两者相等
        } catch (e) {}
        var body = el.querySelector('.mg-body'), br = body.getBoundingClientRect(), bs = getComputedStyle(body);
        avail = [Math.round(br.width - parseFloat(bs.paddingLeft) - parseFloat(bs.paddingRight)),
                 Math.round(br.height - parseFloat(bs.paddingTop) - parseFloat(bs.paddingBottom))];
      }
      return { count: document.querySelectorAll('.mg-block.mg-full').length,
               lockOn: document.documentElement.classList.contains('mg-full-on'),
               api: window.__mdvDebug.mermaidFullscreen(),
               text: el ? el.querySelector('[data-mg-act="full"]').textContent : '',
               w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0,
               vw: window.innerWidth, vh: window.innerHeight,
               drawn: drawn, avail: avail, scale: scale };
    })()`);
    check('全屏后那一块铺满窗口（其它块不受影响）',
      full.count === 1 && full.api === true && full.w >= full.vw - 4 && full.h >= full.vh - 4, JSON.stringify(full));
    /* 全屏的意义就是「看得更大」：图要按容器等比放大到放得下的最大尺寸。
       曾经的坑：mermaid 的 svg 没有 intrinsic 宽高，放开 max-width 后会退回替换元素
       默认的 300×150，于是周围全是空白、图还是很小的（回归见 git 历史）。 */
    check('全屏后图按比例放大到接近可用空间（顶满能顶的那一轴，不超出）',
      !!full.drawn && !!full.avail &&
      Math.max(full.drawn[0] / full.avail[0], full.drawn[1] / full.avail[1]) >= 0.9 &&
      full.drawn[0] <= full.avail[0] + 2 && full.drawn[1] <= full.avail[1] + 2,
      JSON.stringify({ drawn: full.drawn, avail: full.avail }));
    check('放大是等比的（横竖缩放系数一致，没有拉变形）',
      !!full.scale && Math.abs(Math.abs(full.scale[0]) - Math.abs(full.scale[1])) < 0.01,
      JSON.stringify(full.scale));
    check('全屏时锁住页面滚动', full.lockOn === true);
    check('按钮文案变成「退出全屏」', full.text === '退出全屏', full.text);
    await cdp.shot('31-mermaid-fullscreen.png');
    await cdp.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(300);
    const esc = await cdp.ev(`(function(){
      return { count: document.querySelectorAll('.mg-block.mg-full').length,
               lockOn: document.documentElement.classList.contains('mg-full-on'),
               api: window.__mdvDebug.mermaidFullscreen() };
    })()`);
    check('Esc 退出全屏并解锁滚动', esc.count === 0 && esc.lockOn === false && esc.api === false, JSON.stringify(esc));
    check('全屏交互无 console 错误', cdp.errors().length === 0, cdp.errors().join('; '));

    console.log('\n--- D. 深色主题重画 ---');
    const lightSvg = await cdp.ev(`window.__mdvDebug.exportMermaidSvg(0).text()`);
    cdp.events.length = 0;
    await cdp.ev("document.getElementById('themeBtn').click()");
    const rerendered = await cdp.waitFor(READY, 40000);
    await sleep(600);
    s = await cdp.ev(SUMMARY);
    const darkSvg = await cdp.ev(`window.__mdvDebug.exportMermaidSvg(0).text()`);
    const themeAttr = await cdp.ev("document.documentElement.getAttribute('data-theme')");
    check('切深色后所有图都重画完成', rerendered && s.ok === fenceCount - 1, `ok=${s.ok}/${fenceCount - 1} theme=${themeAttr}`);
    check('深色下导出底色变成深色', /fill="#0d1117"/.test(darkSvg), darkSvg.slice(0, 80));
    check('主题真的画进了 SVG（前后内容不同）', darkSvg !== lightSvg);
    check('重画后无 console 错误', cdp.errors().length === 0, cdp.errors().join('; '));
    await cdp.shot('32-mermaid-dark.png');
    await cdp.ev("document.getElementById('themeBtn').click()");   // 切回浅色
    await cdp.waitFor(READY, 40000);
    await sleep(400);

    console.log('\n--- E. .mermaid 里写 stateDiagram-v2 → 按图表渲染 ---');
    if (!diagramDoc) {
      check('文档目录里有 .mermaid 图表样例', false, '缺 docs/示例/状态机示例.mermaid');
    } else {
      cdp.events.length = 0;
      const chipText = await cdp.ev(`(function(){
        var a = [].slice.call(document.querySelectorAll('#tree .docitem'))
          .filter(function(x){ return (x.getAttribute('href')||'').indexOf(encodeURIComponent(${JSON.stringify(diagramDoc.path)})) >= 0; })[0];
        var chip = a ? a.querySelector('.chip-mm') : null;
        return chip ? chip.textContent : null;
      })()`);
      await cdp.ev(`location.hash = '#p=' + encodeURIComponent(${JSON.stringify(diagramDoc.path)})`);
      const dReady = await cdp.waitFor(READY, 40000);
      s = await cdp.ev(SUMMARY);
      const diagramState = await cdp.ev(`(function(){
        var st = window.__mdvDebug.state;
        return { diagram: !!(st.diagram && st.diagram.path), mindmap: !!st.mindmap, paths: st.mindmap ? st.mindmap.path : null };
      })()`);
      console.log('   ' + JSON.stringify({ chip: chipText, blocks: s.mgBlocks, ok: s.ok, tocTitle: s.tocTitle, hasMmWrap: s.hasMmWrap }));
      check('.mermaid 图表文档也画出了图', dReady && s.ok === 1 && s.withSvg === 1, JSON.stringify(s.errors));
      check('图里有中文状态名与注释', /上电自检|空闲待命|本地缓存|断链时先把结果落盘/.test(s.firstText), s.firstText.slice(0, 80));
      check('没有走思维导图画布', s.hasMmWrap === false && s.mmNodes === 0);
      check('左栏标记是「图表」而不是「导图」', chipText === '图表', String(chipText));
      check('右栏标题变成「图表」', s.tocTitle === '图表', s.tocTitle);
      check('内部状态切到了图表模式', diagramState.diagram === true && diagramState.mindmap === false, JSON.stringify(diagramState));
      check('无 console 错误', cdp.errors().length === 0, cdp.errors().join('; '));
      await cdp.shot('33-mermaid-diagram-doc.png');
    }

    console.log('\n--- F. 原来的 mindmap 文档不受影响 ---');
    if (!mindmapDoc) {
      check('文档目录里有 mindmap 样例', false, '缺 .mermaid 导图');
    } else {
      cdp.events.length = 0;
      await cdp.ev(`location.hash = '#p=' + encodeURIComponent(${JSON.stringify(mindmapDoc.path)})`);
      const mmOk = await cdp.waitFor("document.querySelectorAll('#mmSvgEl g.markmap-node').length > 0", 30000);
      s = await cdp.ev(SUMMARY);
      check('mindmap 版式的 .mermaid 仍按导图渲染', mmOk && s.mmNodes > 5 && s.mgBlocks === 0,
        `nodes=${s.mmNodes} mgBlocks=${s.mgBlocks}`);
      check('无 console 错误', cdp.errors().length === 0, cdp.errors().join('; '));
    }

    console.log('\n--- G. 关掉 mermaid.enabled → 围栏退回普通代码块 ---');
    const off = JSON.parse(originalConfig.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));
    off.mermaid = Object.assign({}, off.mermaid || {}, { enabled: false });
    fs.writeFileSync(CONFIG, JSON.stringify(off, null, 2), 'utf8');
    cdp.events.length = 0;
    await cdp.send('Page.reload', { ignoreCache: true });
    await cdp.waitFor("document.querySelectorAll('#tree .docitem').length>0");
    await cdp.ev(`location.hash = '#p=' + encodeURIComponent(${JSON.stringify(demoDoc.path)})`);
    await sleep(900);
    s = await cdp.ev(SUMMARY);
    const enabledOff = await cdp.ev("window.__mdvDebug.mermaidEnabled()");
    check('关闭后不再生成图表块', s.mgBlocks === 0 && enabledOff === false, `blocks=${s.mgBlocks} enabled=${enabledOff}`);
    check('关闭后围栏退回普通代码块（源码仍可见）', s.codeFences === fenceCount, `codeFences=${s.codeFences}/${fenceCount}`);
    check('关闭后正文照常渲染（不白屏）', s.tocItems >= 5, 'tocItems=' + s.tocItems);
    check('关闭后无 console 错误', cdp.errors().length === 0, cdp.errors().join('; '));
    await cdp.shot('34-mermaid-disabled.png');

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
    /* --serve 不写任何产物，临时改过的 config.json 也还原了，剩下的只有开头那次构建的结果 */
  }
})();
