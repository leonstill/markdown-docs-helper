/* =====================================================================
 * Mermaid「文档风」样式界面回归（无头 Chrome + CDP）
 *
 * 覆盖 config.mermaid.style（doc / plain）在真实页面里的效果：
 *   · doc：状态图圆角 10px、节点描边 1.6px、连线 1.6、标签底片不透明浅灰、
 *          箭头 marker 缩到 13；流程图也套上同一套线宽
 *   · 标签不被截字（foreignObject 装得下渲染出来的文字）—— 这条最容易回归：
 *     一旦在注入的 CSS 里改边标签的 font-size / padding，标签就会被切掉半边
 *   · plain：完全不注入样式段，各项退回 mermaid 原样（rx5 / 1px / marker 20）
 *   · 深色：节点底色与标签底片跟着换，线宽不变
 *   · 导出的 SVG 自带这套样式（单独打开也对），且 marker 引用仍然有效
 *
 * 基准文档：docs/示例/状态图版式对照.md（自带 3 张状态图 + 1 张流程图）。
 * 自己拉起 --serve 实例并自动收尾；临时改 config.json 后一定会还原。
 * 用法：node test/mermaid-style-ui.mjs   （需要能启动 Chrome，可用 CHROME 覆盖路径）
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
const DEMO_DOC = 'docs/示例/状态图版式对照.md';
const CDP_PORT = Number(process.env.CDP_PORT || 9399);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error('x 找不到浏览器：' + CHROME + '\n  用环境变量 CHROME 指定路径。');
  process.exit(1);
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail === undefined ? '' : String(detail) });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '   <- ' + (detail === undefined ? '' : detail)}`);
}
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
async function waitJson(url, timeoutMs = 25000) {
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
  async waitFor(expr, timeoutMs = 45000) {
    const t0 = Date.now();
    for (;;) {
      try { if (await this.ev(expr)) return true; } catch (e) {}
      if (Date.now() - t0 > timeoutMs) return false;
      await sleep(150);
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

/* 每块图的关键指标：形状、线宽、标签底片、箭头、以及「标签有没有被截」 */
const PROBE = `(function(){
  var blocks = document.querySelectorAll('#article .mg-block');
  function metrics(el){
    var svg = el.querySelector('.mg-host > svg');
    if (!svg) return { err: 'no svg', kind: el.getAttribute('data-mg-kind') };
    function cs(sel, prop){ var e2 = svg.querySelector(sel); return e2 ? getComputedStyle(e2)[prop] : null; }
    var st = svg.querySelector('style');
    var lbl = null;
    var all = svg.querySelectorAll('g.edgeLabel span.edgeLabel');
    for (var i = 0; i < all.length; i++) if (all[i].textContent.trim()) { lbl = all[i]; break; }
    var fo = svg.querySelector('g.edgeLabel foreignObject:not([width="0"])');
    var lblDiv = lbl ? (lbl.closest('.labelBkg') || lbl.closest('div')) : null;
    return {
      kind: el.getAttribute('data-mg-kind'),
      state: el.getAttribute('data-mg-state'),
      hasCss: !!(st && st.textContent.indexOf('markdown-docs-helper') >= 0),
      nodeRx: cs('.statediagram-state rect.basic, .node rect', 'rx'),
      nodeSW: cs('.statediagram-state rect.basic, .node rect', 'strokeWidth'),
      nodeFill: cs('.statediagram-state rect.basic, .node rect', 'fill'),
      edgeSW: cs('path.transition, .flowchart-link', 'strokeWidth'),
      labelBg: lblDiv ? getComputedStyle(lblDiv).backgroundColor : null,
      labelText: lbl ? lbl.textContent.trim() : '',
      foW: fo ? Number(fo.getAttribute('width')) : null,
      foScrollW: fo ? fo.scrollWidth : null,
      foH: fo ? Number(fo.getAttribute('height')) : null,
      foScrollH: fo ? fo.scrollHeight : null,
      /* 连线**实际引用**的那个 marker（引擎给的是 -margin 变体）被微调成了什么样。
         注意：不能按 id 后缀去猜「哪个是箭头」——引擎每类都 emit 两个 id，只有 -margin
         那个会被引用（见 assets/md-app.js 里 mgTuneMarkers 的注释）。 */
      arrow: (function(){
        var edge = svg.querySelector('[marker-end]');
        var v = edge ? String(edge.getAttribute('marker-end') || '') : '';
        /* 这段是放在模板字符串里的，正则里的反斜杠会被吃掉 —— 用字符串切，别用正则 */
        var at = v.indexOf('url(#');
        var ref = (at >= 0 && v.lastIndexOf(')') > at) ? v.slice(at + 5, v.lastIndexOf(')')) : null;
        var mk = ref ? svg.querySelector('marker[id="' + ref + '"]') : null;
        if (!mk) return { ref: ref || null, found: false };
        var p = mk.querySelector('path');
        var bb = null;
        try { bb = p ? p.getBBox() : null; } catch (e) {}
        var vw = parseFloat(mk.getAttribute('markerWidth'));
        var vh = parseFloat(mk.getAttribute('markerHeight'));
        var sw = p ? parseFloat(getComputedStyle(p).strokeWidth) || 0 : 0;
        var hasVB = !!mk.getAttribute('viewBox');
        /* 视口就是裁剪框，但 overflow:visible 时不裁 —— 两种都算「没被切」 */
        var noClip = hasVB || mk.getAttribute('overflow') === 'visible' ||
          getComputedStyle(mk).overflow === 'visible';
        return {
          ref: ref, found: true,
          w: mk.getAttribute('markerWidth'), h: mk.getAttribute('markerHeight'),
          units: mk.getAttribute('markerUnits'), viewBox: mk.getAttribute('viewBox'),
          overflow: mk.getAttribute('overflow') || getComputedStyle(mk).overflow,
          strokeW: p ? getComputedStyle(p).strokeWidth : null,
          stroke: p ? getComputedStyle(p).stroke : null,
          join: p ? getComputedStyle(p).strokeLinejoin : null,
          pathBox: bb ? [+bb.width.toFixed(2), +bb.height.toFixed(2)] : null,
          clipped: !!(bb && !noClip && (bb.x - sw / 2 < -0.01 || bb.y - sw / 2 < -0.01 ||
            bb.x + bb.width + sw / 2 > vw + 0.01 || bb.y + bb.height + sw / 2 > vh + 0.01))
        };
      })()
    };
  }
  return { count: blocks.length, blocks: [].map.call(blocks, metrics) };
})()`;

const READY = `(function(){
  var b = window.__mdvDebug ? window.__mdvDebug.mermaidBlocks() : [];
  return b.length > 0 && b.every(function(x){ return x.state === 'ok' || x.state === 'error'; });
})()`;

(async () => {
  const profile = path.join(os.tmpdir(), 'mdh-mgstyle-' + Date.now());
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
    if (!(idx.docs || []).some((d) => d.path === DEMO_DOC)) {
      console.error(`x 文档目录里没有「${DEMO_DOC}」，无法验证（先跑一次 node build-docs.mjs）`);
      process.exitCode = 1;
      return;
    }
    const list = await waitJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
    ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

    const openDemo = async () => {
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/index.html` });
      await cdp.waitFor("document.querySelectorAll('#tree .docitem').length>0");
      await cdp.ev(`location.hash = '#p=' + encodeURIComponent(${JSON.stringify(DEMO_DOC)})`);
      return cdp.waitFor(READY);
    };
    const firstOf = (m, kind) => (m.blocks || []).find((b) => b.kind === kind) || {};

    console.log('\n--- A. 默认 doc 样式 ---');
    cdp.events.length = 0;
    check('文档打开并画完所有图', await openDemo());
    let m = await cdp.ev(PROBE);
    console.log('   ' + JSON.stringify(m.blocks.map((b) => ({
      k: b.kind, css: b.hasCss, rx: b.nodeRx, sw: b.nodeSW, edge: b.edgeSW, bg: b.labelBg,
      arrow: b.arrow && b.arrow.found ? `${b.arrow.w}x${b.arrow.h} ${b.arrow.strokeW} ${b.arrow.overflow}` : b.arrow && b.arrow.ref
    }))));
    const state = firstOf(m, 'statediagram-v2');
    const flow = firstOf(m, 'flowchart');
    check('状态图与流程图都画出来了（4 张状态图 + 1 张流程图）',
      m.count === 5 && m.blocks.filter((b) => b.kind === 'statediagram-v2').length === 4,
      'count=' + m.count + ' kinds=' + JSON.stringify(m.blocks.map((b) => b.kind)));
    check('状态图：圆角 10px', state.nodeRx === '10px', state.nodeRx);
    check('状态图：节点描边 1.6px', state.nodeSW === '1.6px', state.nodeSW);
    check('状态图：连线 1.6', parseFloat(state.edgeSW) === 1.6, state.edgeSW);
    check('状态图：标签底片是不透明浅灰', state.labelBg === 'rgb(240, 240, 240)', state.labelBg);
    /* 箭头这条最容易默默失效：引擎每类 emit 两个 marker id（`...End` 与 `...End-margin`），
       真正被引用的是 `-margin` 那个，而且它不在 <defs> 里。所以这里必须查「连线引用的那个」。 */
    check('状态图：微调落在连线实际引用的 marker 上（`-margin` 变体，缩到 13×11）',
      state.arrow.found && /barbEnd-margin$/.test(state.arrow.ref || '') &&
      state.arrow.w === '13' && state.arrow.h === '11' && state.arrow.units === 'userSpaceOnUse',
      JSON.stringify(state.arrow));
    check('状态图：箭头加了一圈 1.1 的描边（细倒钩才读得成实心小三角）',
      parseFloat(state.arrow.strokeW) === 1.1 && state.arrow.join === 'miter' &&
      /^rgb\(/.test(state.arrow.stroke || ''),
      `strokeW=${state.arrow.strokeW} join=${state.arrow.join} stroke=${state.arrow.stroke}`);
    check('状态图：箭头没有被自己的视口切掉（视口就是裁剪框，见 overflow:visible）',
      state.arrow.clipped === false && state.arrow.pathBox &&
      state.arrow.pathBox[0] < 13 && state.arrow.pathBox[1] < 11,
      JSON.stringify(state.arrow));
    check('状态图：标签没被截字（底片装得下文字）',
      state.foW >= state.foScrollW - 0.5 && state.foH >= state.foScrollH - 0.5,
      `fo=${state.foW}x${state.foH} scroll=${state.foScrollW}x${state.foScrollH}`);
    check('状态图：中文/字母标签没被转成实体', state.labelText === 'din=1' || state.labelText === 'din=0',
      JSON.stringify(state.labelText));
    check('流程图：也套上了同一套线宽', flow.hasCss === true && parseFloat(flow.edgeSW) === 1.6,
      `css=${flow.hasCss} edge=${flow.edgeSW}`);
    check('流程图：箭头也补上了描边（几何不动，它本来就是实心三角）',
      parseFloat(flow.arrow.strokeW) === 1.1 && flow.arrow.units === 'userSpaceOnUse',
      JSON.stringify(flow.arrow));
    check('无 console 错误', cdp.errors().length === 0, cdp.errors().join('; '));

    console.log('\n--- B. style=plain 回到 mermaid 原样 ---');
    const plainCfg = JSON.parse(originalConfig.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));
    plainCfg.mermaid = Object.assign({}, plainCfg.mermaid, { style: 'plain' });
    fs.writeFileSync(CONFIG, JSON.stringify(plainCfg, null, 2), 'utf8');
    cdp.events.length = 0;
    await openDemo();
    m = await cdp.ev(PROBE);
    const p0 = firstOf(m, 'statediagram-v2');
    console.log('   ' + JSON.stringify({ rx: p0.nodeRx, sw: p0.nodeSW, edge: p0.edgeSW, bg: p0.labelBg, css: p0.hasCss }));
    check('plain：不注入样式段', p0.hasCss === false);
    check('plain：圆角回到 5px', p0.nodeRx === '5px', p0.nodeRx);
    check('plain：节点描边回到 1px', p0.nodeSW === '1px', p0.nodeSW);
    check('plain：连线回到 1', parseFloat(p0.edgeSW) === 1, p0.edgeSW);
    /* 箭头在 plain 下必须回到 mermaid 原样：20×14 的细长倒钩，没有那圈描边 */
    check('plain：箭头回到 mermaid 原样（20×14，没有那圈描边）',
      p0.arrow.found && p0.arrow.w === '20' && p0.arrow.h === '14' && parseFloat(p0.arrow.strokeW) < 1.1,
      JSON.stringify(p0.arrow));
    check('plain：箭头比 doc 的大（doc 缩到约 2/3、再补描边）',
      p0.arrow.pathBox && state.arrow.pathBox && p0.arrow.pathBox[0] > state.arrow.pathBox[0] * 1.3 &&
      p0.arrow.pathBox[1] > state.arrow.pathBox[1] * 1.3,
      `plain=${JSON.stringify(p0.arrow.pathBox)} doc=${JSON.stringify(state.arrow.pathBox)}`);
    check('plain：无 console 错误', cdp.errors().length === 0, cdp.errors().join('; '));

    console.log('\n--- C. 深色主题 ---');
    fs.writeFileSync(CONFIG, originalConfig, 'utf8');
    cdp.events.length = 0;
    await openDemo();
    await cdp.ev("document.documentElement.getAttribute('data-theme') !== 'dark' && document.getElementById('themeBtn').click()");
    check('切深色后重画完成', await cdp.waitFor(READY));
    await sleep(500);
    m = await cdp.ev(PROBE);
    const d0 = firstOf(m, 'statediagram-v2');
    console.log('   ' + JSON.stringify({ fill: d0.nodeFill, bg: d0.labelBg, sw: d0.nodeSW }));
    check('深色：节点底色换成深紫', d0.nodeFill === 'rgb(35, 35, 56)', d0.nodeFill);
    check('深色：标签底片换成深色底', d0.labelBg === 'rgb(28, 33, 40)', d0.labelBg);
    check('深色：线宽保持 1.6', d0.nodeSW === '1.6px', d0.nodeSW);
    check('深色：箭头跟着换成浅色（描边色也走主题变量）',
      d0.arrow.stroke === 'rgb(154, 164, 178)' && d0.arrow.clipped === false, JSON.stringify(d0.arrow));
    await cdp.ev("document.getElementById('themeBtn').click()");
    await cdp.waitFor(READY);
    check('切回浅色后无 console 错误', cdp.errors().length === 0, cdp.errors().join('; '));

    console.log('\n--- D. 导出的 SVG 自带这套样式 ---');
    cdp.events.length = 0;
    const svgTxt = await cdp.ev(`window.__mdvDebug.exportMermaidSvg(0).text()`);
    check('导出 SVG 里带着样式段', svgTxt.indexOf('markdown-docs-helper') >= 0);
    check('导出 SVG 里圆角是 10px', /rx:10px\s*!important/.test(svgTxt), svgTxt.slice(0, 60));
    check('导出 SVG 里 marker 已缩到 13×11', /markerWidth="13"/.test(svgTxt) && /markerHeight="11"/.test(svgTxt));
    check('导出 SVG 里箭头微调带得上（描边色 + miter，单独打开也对）',
      /<marker [^>]*barbEnd[^>]*>[\s\S]{0,400}?stroke-linejoin="miter"/.test(svgTxt) &&
      /\[id\*="stateDiagram-barbEnd"\] path\{[^}]*stroke-width/.test(svgTxt));
    /* 之前这条断言写死了「引用的 id 一定是 `..._stateDiagram-barbEnd`」，
       引擎升到 v11 之后引用变成了 `...barbEnd-margin`，于是它一直红着 ——
       而真正该守的是「引用哪个 id，defs 里就得有那个 id」。 */
    check('导出 SVG 里 marker 引用仍然有效（每个 marker-end 的 id 都在 defs 里）',
      (function () {
        const refs = svgTxt.match(/marker-(?:end|start)="url\(#[^)]+\)"/g) || [];
        if (!refs.length) return false;
        return refs.every((r) => {
          const id = /url\(#([^)]+)\)/.exec(r)[1];
          return svgTxt.indexOf('<marker id="' + id + '"') >= 0;
        });
      })(), 'refs=' + JSON.stringify((svgTxt.match(/marker-end="url\(#[^)]+\)"/g) || []).slice(0, 2)));
    check('导出后无 console 错误', cdp.errors().length === 0, cdp.errors().join('; '));

    console.log('\n--- E. 关掉 mermaid.enabled 时样式段也不该出现 ---');
    const offCfg = JSON.parse(originalConfig.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));
    offCfg.mermaid = Object.assign({}, offCfg.mermaid, { enabled: false });
    fs.writeFileSync(CONFIG, JSON.stringify(offCfg, null, 2), 'utf8');
    cdp.events.length = 0;
    await cdp.send('Page.reload', { ignoreCache: true });
    await cdp.waitFor("document.querySelectorAll('#tree .docitem').length>0");
    await cdp.ev(`location.hash = '#p=' + encodeURIComponent(${JSON.stringify(DEMO_DOC)})`);
    await sleep(900);
    const offCount = await cdp.ev("document.querySelectorAll('#article .mg-block').length");
    check('关闭后不再生成图表块（也就没有样式段）', offCount === 0, 'blocks=' + offCount);
    check('关闭后无 console 错误', cdp.errors().length === 0, cdp.errors().join('; '));

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
