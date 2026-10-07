/* =====================================================================
 * 端口顺延回归（纯 Node，不需要浏览器）
 *
 * 守的是那个真实踩过的坑：`node build-docs.mjs --serve --port 9001` 报
 * 「端口小于 1024 需要管理员权限」—— 9001 明明大于 1024。
 *
 * 根因（Windows 实测的绑定矩阵，见下面的注释）：
 *   · 别人在同一地址上监听        → EADDRINUSE；
 *   · 别人【独占】监听该端口      → EACCES（WSAEACCES 10013），比如 mosquitto 占着
 *     0.0.0.0:9001、系统组件占着 5357；netsh 预留段里的端口也会这样；
 *   · 别人绑 0.0.0.0、自己绑 127.0.0.1 → Windows 允许，两边都正常。
 *   脚本当时只把 EADDRINUSE 当「端口被占用」，于是 EACCES 一律被翻译成
 *   「小于 1024 需要管理员权限」，答非所问。
 *
 * 覆盖：
 *   1. 端口被占用（EADDRINUSE）      → 顺延、打印原因、启动信息印真实端口、不许提 1024
 *   2. 端口被独占（EACCES）          → 同上，且原因必须写成 EACCES（本机找不到这种端口就跳过）
 *   3. 连续 11 个端口全被占用        → 明确报「都绑不上」并给自查命令
 *   4. 1024 以下的特权端口（--port 80）→ 要么明确报权限，要么本机真能绑，不许静默顺延
 *
 * 子进程的 stdout/stderr 写进 test/.cache/ 下的文件而不是管道：受限沙箱里管道会 EPERM。
 *
 * 用法：node test/serve-port.mjs
 * ===================================================================== */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'test', '.cache');
fs.mkdirSync(CACHE, { recursive: true });
const BUILD = path.join(ROOT, 'build-docs.mjs');
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

/** 试绑一下就放掉：返回 'OK' 或错误码（EADDRINUSE / EACCES …） */
function tryBind(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.on('error', (e) => resolve(e.code));
    srv.listen(port, host, () => srv.close(() => resolve('OK')));
  });
}

/** 真的占住一个端口（用于模拟「被别人占用」） */
function holdPort(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(port, host, () => resolve(srv));
  });
}

/** 找一段连续 n 个都空闲的端口（Windows 动态端口从 49152 起，所以从 40000 往上找） */
async function findFreeWindow(n, from = 40000, span = 4000) {
  let p = from;
  while (p + n - 1 < from + span) {
    if (await tryBind(p) !== 'OK') { p += 1; continue; }
    let i = 1;
    for (; i < n; i++) if (await tryBind(p + i) !== 'OK') break;
    if (i === n) return p;
    p += i + 1;
  }
  return null;
}

/** 外部命令的输出走文件（受限沙箱里管道会 EPERM），返回文本 */
function capture(cmd, args, tag) {
  const file = path.join(CACHE, `serve-port-${tag}.txt`);
  const fd = fs.openSync(file, 'w');
  let r;
  try {
    r = spawnSync(cmd, args, { stdio: ['ignore', fd, fd] });
  } finally {
    fs.closeSync(fd);
  }
  return r.status === 0 ? fs.readFileSync(file, 'utf8') : '';
}

/** 本机正在 TCP 监听的端口 */
function listeningPorts() {
  if (process.platform !== 'win32') return [];
  return capture('netstat', ['-ano'], 'netstat')
    .split('\n')
    .map((l) => /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING/i.exec(l))
    .filter(Boolean)
    .map((m) => Number(m[1]));
}

/** 系统预留（Hyper-V/WSL/Docker 等）端口段的起始端口 */
function excludedStartPorts() {
  if (process.platform !== 'win32') return [];
  // 只认「两个数字」的数据行，绕开中文/英文表头的差异
  return capture('netsh', ['interface', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'], 'excluded')
    .split('\n')
    .map((l) => /^\s*(\d{1,5})\s+(\d{1,5})/.exec(l))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .filter((p) => p >= 1024 && p <= 65535);
}

/** 找一个「再绑就拿 EACCES」的端口：本机被独占监听或落在预留段里的那些 */
async function findEaccesPort() {
  const candidates = [...new Set([...excludedStartPorts(), ...listeningPorts()])]
    .filter((p) => p >= 1024 && p <= 65535)
    .sort((a, b) => a - b);
  for (const p of candidates.slice(0, 80)) {
    if (await tryBind(p) === 'EACCES') return p;
  }
  return null;
}

/** 起一个 --serve 子进程，输出落到文件 */
function launch(tag, args) {
  const outFile = path.join(CACHE, `serve-port-${tag}.out`);
  const errFile = path.join(CACHE, `serve-port-${tag}.err`);
  const fdOut = fs.openSync(outFile, 'w');
  const fdErr = fs.openSync(errFile, 'w');
  let proc;
  try {
    proc = spawn(process.execPath, [BUILD, '--serve', ...args], { cwd: ROOT, stdio: ['ignore', fdOut, fdErr] });
  } finally {
    fs.closeSync(fdOut);
    fs.closeSync(fdErr);
  }
  return { proc, text: () => fs.readFileSync(outFile, 'utf8') + fs.readFileSync(errFile, 'utf8') };
}

/** 在候选端口里等一个能应答的（服务真的起来了）；返回该端口或 null */
async function waitAny(ports, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    for (const p of ports) {
      try {
        const r = await fetch(`http://127.0.0.1:${p}/docs-index.json`);
        if (r.ok) return p;
      } catch (e) { /* 还没起来 */ }
    }
    await sleep(150);
  }
  return null;
}

/** 等子进程退出，或者等它真的在某个端口上服务起来；返回 'exit' / 那个端口 / null */
async function waitExitOrUp(proc, ports, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return 'exit';
    for (const p of ports) {
      try {
        const r = await fetch(`http://127.0.0.1:${p}/docs-index.json`);
        if (r.ok) return p;
      } catch (e) { /* 还没起来 */ }
    }
    await sleep(150);
  }
  return null;
}

/** 等子进程自己退出（用退出码断言）；超时返回 null */
async function waitExit(proc, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return proc.exitCode;
    await sleep(100);
  }
  return null;
}

async function stop(proc) {
  if (proc.exitCode === null) proc.kill();
  await sleep(300);
}

/** 顺延类的公共断言：原因要打印、要真的落到后面的端口、且不许再提 1024 */
async function expectFallback(tag, port, wantCode) {
  const s = launch(tag, ['--port', String(port)]);
  try {
    const hit = await waitAny(Array.from({ length: 10 }, (_, i) => port + 1 + i), 30000);
    const text = s.text();
    const why = text.split('\n').find((l) => l.includes('绑不上')) || '(没有顺延提示)';
    check(s.proc.exitCode === null, `服务没有退出（旧行为是整个进程报错退出）`, `exit=${s.proc.exitCode}；${why}`);
    check(text.includes(`! 端口 ${port} 绑不上（`), '把顺延原因打印出来了', why);
    check(wantCode === null || text.includes(`绑不上（${wantCode}）`), `原因是 ${wantCode}`, why);
    check(hit !== null, `真的顺延到后面的端口并能访问（${port} → ${hit}）`,
      text.trim().split('\n').slice(-3).join(' | '));
    if (hit !== null) check(text.includes(`监听地址：127.0.0.1:${hit}`), '启动信息里印的是真实端口',
      text.split('\n').find((l) => l.includes('监听地址')));
    check(!text.includes('小于 1024'), '没有再提「小于 1024」（这正是原来的 bug）',
      text.split('\n').find((l) => l.includes('小于 1024')));
  } finally {
    await stop(s.proc);
  }
}

/* ---------------- 1. 端口被占用（EADDRINUSE）---------------- */
console.log('\n--- 端口在同一地址上已被占用（EADDRINUSE）---');
{
  const P = await freePort();
  const holder = await holdPort(P, '127.0.0.1');
  try {
    await expectFallback('busy', P, 'EADDRINUSE');
  } finally {
    holder.close();
  }
}

/* ---------------- 2. 端口被别人独占监听（EACCES）---------------- */
console.log('\n--- 端口被别人独占监听（EACCES：mosquitto 占 9001 那种）---');
{
  const P = await findEaccesPort();
  if (P === null) {
    console.log('  - 本机现有监听端口里没有「再绑就 EACCES」的（独占监听/系统预留），跳过');
  } else {
    console.log(`  · 用 ${P}（再绑就是 EACCES）试`);
    await expectFallback('eacces', P, 'EACCES');
  }
}

/* ---------------- 3. 连续 11 个端口全被占用 ---------------- */
console.log('\n--- 连续 11 个端口都被占用 ---');
{
  const P = await findFreeWindow(11);
  if (P === null) {
    console.log('  - 找不到连续的 11 个空闲端口，跳过');
  } else {
    const holders = [];
    let ok = true;
    try {
      for (let i = 0; i < 11; i++) holders.push(await holdPort(P + i, '127.0.0.1'));
    } catch (e) {
      ok = false;   // 端口被别的程序抢走了，这一轮不算
    }
    if (!ok) {
      console.log('  - 占端口时被别的程序抢走，跳过');
    } else {
      const s = launch('exhausted', ['--port', String(P)]);
      const code = await waitExit(s.proc, 30000);
      const text = s.text();
      check(code === 1 && text.includes('都绑不上'),
        '试完 11 个端口都不行时，明确报「都绑不上」（不再只说「被占用」）',
        `exit=${code}；${text.trim().split('\n')[0]}`);
      check(text.includes('netstat') || text.includes('excludedportrange'),
        '报错里给了自己查占用的命令', text.trim().split('\n')[0]);
      check(!text.includes('小于 1024'), '也没有误报成特权端口',
        text.split('\n').find((l) => l.includes('小于 1024')));
      await stop(s.proc);
    }
    holders.forEach((h) => h.close());
  }
}

/* ---------------- 4. 1024 以下的特权端口 ---------------- */
console.log('\n--- 1024 以下的特权端口（--port 80）---');
{
  const s = launch('privileged', ['--port', '80']);
  try {
    const r = await waitExitOrUp(s.proc, [80], 25000);
    const text = s.text();
    if (r === 'exit') {
      check(s.proc.exitCode === 1 && text.includes('小于 1024') && text.includes('管理员权限'),
        '明确报「小于 1024 需要管理员权限」，而不是「被占用」', text.trim().split('\n')[0]);
      check(!text.includes('绑不上（'), '不会偷偷顺延到 81+', text.trim().split('\n')[0]);
    } else if (r === 80) {
      console.log('  - 本机能以当前身份绑 80（管理员/root 环境），跳过「必须报错」的断言');
    } else {
      check(false, '既没明确报权限、也没真的绑上 80（超时）',
        `exit=${s.proc.exitCode}；${text.trim().split('\n')[0]}`);
    }
  } finally {
    await stop(s.proc);
  }
}

console.log(fail ? `\n===== 失败 ${fail} 项 =====` : '\n===== 全部通过 =====');
process.exit(fail ? 1 : 0);
