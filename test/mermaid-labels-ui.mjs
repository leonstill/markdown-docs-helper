/* =====================================================================
 * Mermaid 边标签避让界面回归（无头 Chrome + CDP）
 *
 * 基准文档：test/fixtures/labels/边标签避让.md
 *   · 两条跨子图的边（GLUE→DRV、DRV→HOST）原本把标签叠在同一个锚点
 *   · SRC→GLUE 的虚线标签原本贴着 GLUE，盖住入箭头
 *
 * 期望（style=doc）：
 *   · 只挪有问题的三个标签，正常的「需求书」保持 dagre 原位
 *   · 任意两个标签不再重叠
 *   · 「可选参考件」离最近节点拉开距离，不再压箭头
 *
 * 用法：node test/mermaid-labels-ui.mjs   （可用 CHROME 覆盖浏览器路径）
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
const DOC_DIR = path.join(HERE, 'fixtures', 'labels');
const SHOTS = path.join(HERE, 'shots');
const CDP_PORT = Number(process.env.CDP_PORT || 9401);
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
        : e.method === 'Log.entryAdded' ? 'log: ' + e.params.entry.text
          : 'console.error: ' + (e.params.args || []).map((a) => a.value || a.description).join(' '))
      .filter((s) => !/favicon/i.test(s));
  }
}

const READY = `(function(){
  var b = window.__mdvDebug ? window.__mdvDebug.mermaidBlocks() : [];
  return b.length > 0 && b.every(function(x){ return x.state === 'ok' || x.state === 'error'; });
})()`;

/* 标签/节点的几何都用页面坐标量：重叠判定与缩放无关；间隙阈值留足余量 */
const PROBE = `(function(){
  var block = document.querySelector('#article .mg-block[data-mg-kind="flowchart"]');
  var svg = block && block.querySelector('.mg-host > svg');
  if (!svg) return { err: 'no svg' };
  function rect(el){ var r = el.getBoundingClientRect(); return { x:r.x, y:r.y, w:r.width, h:r.height }; }
  function gap(a, b){
    var dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
    var dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
    return Math.max(dx, dy);
  }
  var labels = [];
  svg.querySelectorAll('g.edgeLabel').forEach(function(g){
    var t = g.textContent.replace(/\\s+/g, ' ').trim();
    if (!t) return;
    var fo = g.querySelector('foreignObject');
    var bkg = g.querySelector('.labelBkg');
    labels.push({
      text: t, box: rect(g), moved: g.getAttribute('data-mg-label-moved') === '1',
      fo: fo ? [Math.round(fo.getBoundingClientRect().width), Math.round(fo.getBoundingClientRect().height)] : null,
      bkg: bkg ? [Math.round(bkg.getBoundingClientRect().width), Math.round(bkg.getBoundingClientRect().height)] : null
    });
  });
  var nodes = [];
  svg.querySelectorAll('g.node').forEach(function(n){ nodes.push(rect(n)); });
  var overlaps = [];
  for (var i = 0; i < labels.length; i++) {
    for (var j = i + 1; j < labels.length; j++) {
      var d = gap(labels[i].box, labels[j].box);
      if (d < 0) overlaps.push({ a: labels[i].text, b: labels[j].text, d: Math.round(d) });
    }
  }
  var clear = {};
  labels.forEach(function(l){
    var best = Infinity;
    nodes.forEach(function(n){ best = Math.min(best, gap(l.box, n)); });
    clear[l.text] = Math.round(best);
  });
  return {
    count: labels.length,
    labels: labels.map(function(l){ return { text: l.text, moved: l.moved, box: l.box, fo: l.fo, bkg: l.bkg }; }),
    moved: labels.filter(function(l){ return l.moved; }).map(function(l){ return l.text; }).sort(),
    overlaps: overlaps,
    clear: clear
  };
})()`;

(async () => {
  const profile = path.join(os.tmpdir(), 'mdh-mglabel-' + Date.now());
  const serverPort = await freePort();
  const server = spawn(process.execPath,
    [path.join(ROOT, 'build-docs.mjs'), '--serve', '--port', String(serverPort), DOC_DIR],
    { cwd: ROOT, stdio: 'ignore' });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore' });
  let ws = null;

  try {
    await waitJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
    await waitJson(`http://127.0.0.1:${serverPort}/docs-index.json`);
    const idx = JSON.parse(await (await fetch(`http://127.0.0.1:${serverPort}/docs-index.json`)).text());
    const doc = (idx.docs || [])[0];
    if (!doc) { console.error('x fixture 目录里没扫到文档：' + DOC_DIR); process.exitCode = 1; return; }
    console.log(`\n[基准] ${doc.path}  标题「${doc.title}」`);

    const list = await waitJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
    ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

    cdp.events.length = 0;
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/index.html` });
    await cdp.waitFor("document.querySelectorAll('#tree .docitem').length>0");
    await cdp.ev(`location.hash = '#p=' + encodeURIComponent(${JSON.stringify(doc.path)})`);
    check('图表画完了', await cdp.waitFor(READY));
    await sleep(400);

    const m = await cdp.ev(PROBE);
    if (m.err) { console.error('x ' + m.err); process.exitCode = 1; return; }
    console.log('   ' + JSON.stringify(m));

    const expectedMoved = ['setSignal（契约边界）', '动画 / 状态', '可选参考件（含 fanout 配置）'].sort();
    check('共 4 个非空边标签', m.count === 4, JSON.stringify(m.labels));
    check('只挪有冲突的三个标签（需求书保持原位）',
      JSON.stringify(m.moved) === JSON.stringify(expectedMoved), JSON.stringify(m.moved));
    check('任意两个标签不再重叠', m.overlaps.length === 0, JSON.stringify(m.overlaps));
    check('「可选参考件」不再贴着节点（离最近节点 ≥ 20px）',
      m.clear['可选参考件（含 fanout 配置）'] >= 20, m.clear['可选参考件（含 fanout 配置）']);
    check('无 console 错误', cdp.errors().length === 0, cdp.errors().join('; '));

    await cdp.shot('mermaid-labels.png');

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
    try { if (ws) ws.close(); } catch (e) {}
    chrome.kill();
    server.kill();
    await sleep(300);
  }
})();
