/* =====================================================================
 * 视觉/几何抽查（无头 Chrome + CDP）
 *
 * 不是断言型回归，而是把「肉眼要确认的东西」量化打印出来 + 截图：
 *   · 侧栏收起/展开时 margin / width 是否逐帧渐变（而不是瞬间跳变）
 *   · 有没有出现横向滚动条
 *   · 右栏目录列表有没有被滚动条截掉内容（scrollWidth 与 clientWidth）
 *   · 滚动页面后侧栏是否仍然粘在顶栏下方
 *   · 正文切换时的入场动画名
 * 截图落在 test/shots/（anim-*.png）。
 *
 * 用法：node test/shot-anim.mjs
 * ===================================================================== */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const URL = 'file:///' + path.join(ROOT, 'md-viewer.html').replace(/\\/g, '/');
const SHOTS = path.join(HERE, 'shots');
const PORT = 9336;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error('x 找不到浏览器：' + CHROME + '\n  用环境变量 CHROME 指定路径。');
  process.exit(1);
}
fs.mkdirSync(SHOTS, { recursive: true });

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
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
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, file), Buffer.from(r.data, 'base64'));
    console.log(`  截图 shots/${file}  ${(fs.statSync(path.join(SHOTS, file)).size / 1024).toFixed(0)} KB`);
  }
}

const GEO = `(function(){
  var sb=document.querySelector('.sidebar'), tc=document.querySelector('.toc'), tl=document.getElementById('tocList');
  var r=function(e){var b=e.getBoundingClientRect();return {l:Math.round(b.left),r:Math.round(b.right),t:Math.round(b.top),w:Math.round(b.width)};};
  return {
    sb:r(sb), tc:r(tc),
    sbVis:getComputedStyle(sb).visibility, tcVis:getComputedStyle(tc).visibility,
    sbTrans:getComputedStyle(sb).transitionDuration, tcTrans:getComputedStyle(tc).transitionDuration,
    hOverflow:document.documentElement.scrollWidth-window.innerWidth,
    tlScroll:tl.scrollWidth+'/'+tl.clientWidth,
    preload:document.documentElement.classList.contains('preload'),
    anim:getComputedStyle(document.getElementById('article')).animationName
  };
})()`;

(async () => {
  const profile = path.join(os.tmpdir(), 'mdh-shot-' + Date.now());
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile, '--window-size=1400,900', 'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 120 && !wsUrl; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const page = (await r.json()).find((t) => t.type === 'page');
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch (e) {}
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) { chrome.kill(); throw new Error('浏览器没起来'); }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: URL });
  for (let i = 0; i < 100; i++) {
    if (await cdp.ev(`!!document.querySelector('#tree .docitem') && !document.documentElement.classList.contains('preload')`)) break;
    await sleep(120);
  }
  await sleep(400);

  console.log('\n[1] 初始状态（默认只开右栏）');
  console.log('   ', JSON.stringify(await cdp.ev(GEO)));
  await cdp.shot('anim-1-default.png');

  console.log('\n[2] 打开左栏：采样滑动过程 [ms, left, width]');
  console.log('   ', JSON.stringify(await cdp.ev(`(async function(){
    var out=[], sb=document.querySelector('.sidebar');
    document.getElementById('toggleLeft').click();
    var t0=performance.now();
    for (var i=0;i<9;i++){
      await new Promise(function(r){requestAnimationFrame(r);});
      var b=sb.getBoundingClientRect();
      out.push([Math.round(performance.now()-t0), Math.round(b.left), Math.round(b.width)]);
      await new Promise(function(r){setTimeout(r,45);});
    }
    return out;
  })()`)));
  await sleep(400);
  await cdp.shot('anim-2-left-open.png');

  console.log('\n[3] 关闭右栏：采样收窄过程 [ms, width, left]');
  console.log('   ', JSON.stringify(await cdp.ev(`(async function(){
    var out=[], tc=document.querySelector('.toc');
    document.getElementById('toggleRight').click();
    var t0=performance.now();
    for (var i=0;i<9;i++){
      await new Promise(function(r){requestAnimationFrame(r);});
      var b=tc.getBoundingClientRect();
      out.push([Math.round(performance.now()-t0), Math.round(b.width), Math.round(b.left)]);
      await new Promise(function(r){setTimeout(r,45);});
    }
    return out;
  })()`)));
  await sleep(500);
  console.log('    收好后：', JSON.stringify(await cdp.ev(GEO)));
  await cdp.shot('anim-3-both-closed.png');

  console.log('\n[4] 窄屏抽屉 + 遮罩');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 620, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  await cdp.ev(`document.getElementById('toggleRight').click()`);
  await sleep(500);
  console.log('    遮罩 opacity/pointer-events：', await cdp.ev(`(function(){var s=getComputedStyle(document.getElementById('scrim'));return s.opacity+' / '+s.pointerEvents;})()`));
  await cdp.shot('anim-4-narrow.png');
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  console.log('\n[5] 滚动后的粘性 + 换文档动效');
  await cdp.ev(`document.getElementById('toggleRight').click()`);
  await sleep(500);
  await cdp.ev(`document.querySelectorAll('#tree .docitem')[0].click()`);
  await sleep(600);
  console.log('   ', JSON.stringify(await cdp.ev(`(function(){
    window.scrollTo(0, 900);
    var sb=document.querySelector('.sidebar').getBoundingClientRect();
    var t=document.getElementById('tocList');
    return {sbTop:Math.round(sb.top), sbLeft:Math.round(sb.left), hOverflow:document.documentElement.scrollWidth-window.innerWidth, tlScroll:t.scrollWidth+'/'+t.clientWidth};
  })()`)));
  await sleep(300);
  await cdp.shot('anim-5-scrolled.png');
  await cdp.ev(`window.scrollTo(0,0)`);
  await sleep(250);
  await cdp.shot('anim-6-doc.png');

  ws.close();
  chrome.kill();
  console.log('\n完成。');
})().catch((e) => { console.error('x ' + e.message); process.exit(1); });
