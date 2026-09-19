/* =====================================================================
 * 监听地址回归（纯 Node，不需要浏览器）
 *
 * 守的是「服务默认只听 127.0.0.1，但必须能绑到本机 IP 上」这件事：
 *   · 不给参数         → 只绑环回：打印「本机访问」+「仅本机」，不打印局域网地址
 *   · --lan            → 绑 0.0.0.0：既打印局域网地址，也真的能从本机 IP 连上
 *   · --host <本机IP>  → 只绑这个地址，并且能从它连上
 *   · --host <不存在的地址> → 立刻报错退出，提示「本机没有这个地址」
 *
 * 子进程的 stdout/stderr 写进 test/.cache/ 下的文件而不是管道：受限沙箱里管道会 EPERM。
 *
 * 用法：node test/serve-host.mjs
 * ===================================================================== */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'test', '.cache');
fs.mkdirSync(CACHE, { recursive: true });
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

/** 本机的局域网 IPv4（没有就返回 null —— 那种环境只能跳过「从本机 IP 连回来」的断言） */
function lanIPv4() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (!a.internal && a.family === 'IPv4') return a.address;
    }
  }
  return null;
}

/** 起一个 --serve 子进程，等它在 probeHost 上真的能应答为止；stdout/stderr 落到文件供断言 */
async function startServe(tag, extraArgs, probeHost = '127.0.0.1') {
  const port = await freePort();
  const outFile = path.join(CACHE, `serve-host-${tag}.out`);
  const errFile = path.join(CACHE, `serve-host-${tag}.err`);
  const fdOut = fs.openSync(outFile, 'w');
  const fdErr = fs.openSync(errFile, 'w');
  let proc;
  try {
    proc = spawn(process.execPath,
      [path.join(ROOT, 'build-docs.mjs'), '--serve', '--port', String(port), ...extraArgs],
      { cwd: ROOT, stdio: ['ignore', fdOut, fdErr] });
  } finally {
    fs.closeSync(fdOut);
    fs.closeSync(fdErr);
  }
  const url = (host) => `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  for (let i = 0; i < 200; i++) {
    if (proc.exitCode !== null) break;
    try {
      const r = await fetch(url(probeHost) + '/docs-index.json');
      if (r.ok) {
        return {
          proc, port, base: url(probeHost),
          text: () => fs.readFileSync(outFile, 'utf8') + fs.readFileSync(errFile, 'utf8'),
        };
      }
    } catch (e) { /* 还没起来 */ }
    await sleep(100);
  }
  proc.kill();
  throw new Error(`服务没起来（--port ${port} ${extraArgs.join(' ')}）：\n` +
    fs.readFileSync(outFile, 'utf8') + fs.readFileSync(errFile, 'utf8'));
}

async function stop(proc) {
  proc.kill();
  await sleep(300);
}

/** 从任意地址取一次索引，返回是否成功（顺便证明这个地址真的被监听了） */
async function reachable(host, port) {
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}/docs-index.json`;
  try {
    const r = await fetch(url);
    if (!r.ok) return false;
    const idx = await r.json();
    return Array.isArray(idx.docs) && idx.docs.length > 0;
  } catch (e) { return false; }
}

const ip = lanIPv4();

console.log('\n--- 默认：只听环回 ---');
{
  const s = await startServe('default', [], '127.0.0.1');
  try {
    const text = s.text();
    check(await reachable('127.0.0.1', s.port), '默认能通过 127.0.0.1 访问');
    check(text.includes(`监听地址：127.0.0.1:${s.port}`), '打印的监听地址是 127.0.0.1', text.split('\n').find((l) => l.includes('监听地址')));
    check(text.includes('（仅本机）'), '明确标注「仅本机」');
    check(!text.includes('局域网访问'), '默认不打印局域网地址');
    check(text.includes('--serve --lan'), '提示了局域网共享的写法');
    if (ip) check(!(await reachable(ip, s.port)), `默认不会绑到本机 IP（${ip} 连不上）`);
  } finally { await stop(s.proc); }
}

console.log('\n--- --lan：绑定所有网卡 ---');
{
  const s = await startServe('lan', ['--lan'], '127.0.0.1');
  try {
    const text = s.text();
    check(await reachable('127.0.0.1', s.port), '--lan 下环回仍然可访问');
    check(text.includes(`监听地址：0.0.0.0:${s.port}`) && text.includes('所有网卡'),
      '打印的监听地址是 0.0.0.0（所有网卡）', text.split('\n').find((l) => l.includes('监听地址')));
    if (ip) {
      check(text.includes(`局域网访问：http://${ip}:${s.port}/`), `启动了就把局域网地址印出来（${ip}）`);
      check(await reachable(ip, s.port), `能通过本机 IP 访问（${ip}）`);
    } else {
      console.log('  - 本机没有非环回 IPv4，跳过「从本机 IP 连回来」的断言');
    }
  } finally { await stop(s.proc); }
}

console.log('\n--- --host：只绑指定的本机地址 ---');
if (ip) {
  const s = await startServe('ip', ['--host', ip], ip);
  try {
    const text = s.text();
    check(await reachable(ip, s.port), `--host ${ip} 能从该地址访问`);
    check(text.includes(`指定地址访问：http://${ip}:${s.port}/`), '打印的访问地址就是 --host 指定的地址',
      text.split('\n').find((l) => l.includes('指定地址访问')));
    check(!text.includes('局域网访问'), '绑定单个地址时不额外罗列其它网卡');
  } finally { await stop(s.proc); }
} else {
  console.log('  - 本机没有非环回 IPv4，跳过');
}

console.log('\n--- --host：本机不存在的地址要报错 ---');
{
  const port = await freePort();
  const outFile = path.join(CACHE, 'serve-host-bad.out');
  const errFile = path.join(CACHE, 'serve-host-bad.err');
  const fdOut = fs.openSync(outFile, 'w');
  const fdErr = fs.openSync(errFile, 'w');
  let r;
  try {
    r = spawnSync(process.execPath,
      [path.join(ROOT, 'build-docs.mjs'), '--serve', '--host', '203.0.113.7', '--port', String(port)],
      { cwd: ROOT, stdio: ['ignore', fdOut, fdErr], timeout: 60000 });
  } finally {
    fs.closeSync(fdOut);
    fs.closeSync(fdErr);
  }
  const text = fs.readFileSync(outFile, 'utf8') + fs.readFileSync(errFile, 'utf8');
  check(r.status === 1 && text.includes('本机没有这个地址'),
    '绑定不存在的地址：退出码 1，并说清原因', `exit=${r.status}；${text.trim().split('\n')[0] || ''}`);
}

console.log(fail ? `\n===== 失败 ${fail} 项 =====` : '\n===== 全部通过 =====');
process.exit(fail ? 1 : 0);
