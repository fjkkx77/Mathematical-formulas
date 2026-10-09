const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LIVE = [];
const RUN_PREFIX = 'cdp-' + process.pid + '-';   // 本次运行起的所有浏览器都用这个前缀；查残留只查它
function killOne(b) {
  try { require('child_process').execSync('taskkill /PID ' + b.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) {}
  try {
    const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" | Where-Object { $_.CommandLine -like \'*' + b.tag + '*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
    require('child_process').execSync('powershell -NoProfile -Command "' + ps.replace(/"/g, '\\"') + '"', { stdio: 'ignore' });
  } catch (e) {}
  // 刚杀完进程时 profile 目录里的文件句柄还没释放，一次删不掉；重试几次（每次隔约 1 秒）。迁自旧版 lib.js
  for (let i = 0; i < 6; i++) {
    try { fs.rmSync(b.dir, { recursive: true, force: true }); break; }
    catch (e) { try { require('child_process').execSync('ping -n 2 127.0.0.1', { stdio: 'ignore' }); } catch (_) {} }
  }
}
function killAll() { while (LIVE.length) killOne(LIVE.pop()); }
process.on('exit', killAll);
process.on('SIGINT', () => { killAll(); process.exit(1); });
process.on('SIGTERM', () => { killAll(); process.exit(1); });   // 被外部结束（超时、工具取消）时也要收尾
process.on('uncaughtException', e => { console.error('FAIL', e && e.message); killAll(); process.exit(1); });
async function open(w, h, scale) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  // 目录名带上本 node 进程号：多个会话同时跑脚手架时，残留要能分清是谁的。
  // 2026-09-13 踩过：名字全是 cdp-xxxx，凭"启动时间对得上"认领残留，误杀了另一个会话正在跑的测试浏览器
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), RUN_PREFIX));
  const tag = path.basename(dir);
  // 本仓库的副本（抄自 memory/references/组件_浏览器验证脚手架/cdp.js）只改了这一处：
  // 页面的库都从国外 CDN 加载，headless Chrome 不认系统代理，用 MDR_PROXY 环境变量给它指一个（例：http://127.0.0.1:8800）
  const extra = process.env.MDR_PROXY ? ['--proxy-server=' + process.env.MDR_PROXY, '--proxy-bypass-list=127.0.0.1;localhost'] : [];
  const proc = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + dir, '--no-first-run',
     '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', ...extra, 'about:blank'], { stdio: 'ignore' });
  LIVE.push({ pid: proc.pid, dir, tag });
  let ws = null;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/json/list'); const l = await r.json();
      const pg = l.find(x => x.type === 'page'); if (pg) { ws = pg.webSocketDebuggerUrl; break; } } catch (e) {}
    await sleep(250);
  }
  if (!ws) throw new Error('chrome 起不来');
  const sock = new WebSocket(ws); let id = 0; const pend = new Map(); const errors = []; const beforeunloads = [];
  await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej; setTimeout(() => rej(new Error('ws 超时')), 10000); });
  sock.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    } else if (m.method === 'Page.javascriptDialogOpening') {
      // 本仓库副本加的第二处：离开页面时 beforeunload 拦截会弹原生框，headless 下它会卡住 Page.navigate。
      // 记下来（测试要用它证明「有未保存修改时关页面会拦」），然后点「离开」。
      beforeunloads.push(m.params.type);
      sock.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
    }
  };
  const send = (method, params) => { const i = ++id;
    return new Promise((res, rej) => { pend.set(i, { res, rej });
      setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('CDP 超时: ' + method)); } }, 20000);
      sock.send(JSON.stringify({ id: i, method, params: params || {} })); }); };
  const ev = async e => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('EVAL ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description));
    return r.result.value; };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__alerts=[];window.alert=function(m){window.__alerts.push(String(m))};window.confirm=function(){return true};' });
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: scale || 2, mobile: (w < 900), screenWidth: w, screenHeight: h });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const goto = async url => { await send('Page.navigate', { url });
    for (let i = 0; i < 60; i++) { if (await ev('document.readyState') === 'complete') break; await sleep(100); }
    await sleep(300); };
  const shot = async f => { const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(f, Buffer.from(r.data, 'base64')); };
  const close = () => { const i = LIVE.findIndex(x => x.pid === proc.pid); if (i >= 0) killOne(LIVE.splice(i, 1)[0]); };
  // 只截当前视口：验浮层/提示条/指示器这类固定定位元素用这个。长页面别用 shot()——
  // 整页长图 × DPR 3 单张上百 MB，连截十几张会把机器内存吃光、进程被系统杀掉（2026-09-11 踩过）
  const vshot = async f => { const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(f, Buffer.from(r.data, 'base64')); };
  return { ev, send, goto, shot, vshot, close, errors, beforeunloads };
}
module.exports = { open, sleep, RUN_PREFIX };
