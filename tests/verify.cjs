// 数学公式阅读器回归验证：真实 headless Chrome（手机 390 宽 + 电脑 1280 宽）。
// 2026-10-09 从 markdown-reader 的 tests/verify.cjs 移植过来（那边按 2026-10-08 审查报告整改的修复同步到了本站），
// 去掉了本站没有的（KaTeX、代码行号），加了本站特有的（MathJax 按需加载、四种公式定界符、金额防护）。
//
// 用法（在仓库根目录）：
//   MDR_PROXY=http://127.0.0.1:8800 node tests/verify.cjs            # 测仓库里的 index.html
//   MDR_PROXY=http://127.0.0.1:8800 node tests/verify.cjs <目录>     # 测别的目录里的 index.html（比如旧版本，做 A/B）
// 页面的库全从国外 CDN 加载，headless Chrome 不走系统代理，所以要 MDR_PROXY。
// 每条用例开始前清空 localStorage，用例之间互不影响。退出码：全部通过 0，有失败 1。
//
// 判据的原则：每条都要能在旧版本上变红（拿 git show 出来的旧 index.html 跑一遍，确认会失败），否则就是装饰。
const { open, sleep } = require('./lib/cdp.cjs');
const http = require('http'), fs = require('fs'), path = require('path');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const results = [];
function check(name, ok, detail) {
    results.push({ name, ok: !!ok, detail });
    console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail !== undefined ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
}

function serve(root) {
    return new Promise(res => {
        const srv = http.createServer((q, s) => {
            const u = new URL(q.url, 'http://x');
            let rel; try { rel = decodeURIComponent(u.pathname); } catch (_) { s.writeHead(400); return s.end('400'); }
            // 路径里有 0 字节时 fs.readFile 会同步抛错、把整个测试进程带崩，先挡掉
            if (rel.includes('\0')) { s.writeHead(400); return s.end('400'); }
            const f = path.resolve(root, '.' + (rel === '/' ? '/index.html' : rel));
            // 只许读被测目录里的文件：挡住 /../ 、%2e%2e 这类跳出去读本机别的文件的请求
            if (f !== root && !f.startsWith(root + path.sep)) { s.writeHead(403); return s.end('403'); }
            fs.readFile(f, (e, d) => {
                if (e) { s.writeHead(404); return s.end('404'); }
                s.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
                s.end(d);
            });
        }).listen(0, '127.0.0.1', () => res(srv));
    });
}

async function waitFor(c, expr, ms = 15000, step = 100) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        try { const v = await c.ev(expr); if (v) return v; } catch (_) {}
        await sleep(step);
    }
    return false;
}

// 页面里装的「探针」：记录原生弹框调用、截住下载
const INSTRUMENT = `(() => {
    window.__native = [];
    ['alert', 'confirm', 'prompt'].forEach(k => { window[k] = function (m) { window.__native.push(k + ':' + m); return k === 'confirm' ? true : null; }; });
    window.__dl = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__dl.push({ name: this.download, href: this.href }); return; } return orig.call(this); };
    return true;
})()`;

let BASE = '';
async function reset(c, setupJs) {
    await c.goto(BASE);
    await c.ev(`localStorage.clear(); ${setupJs || ''}; true`);
    await c.goto(BASE);
    // MDR_LEGACY=1：测旧版本（A/B）时用宽松的就绪判断——旧版没有 drawerOpen / themeChoice 这些变量
    const ready = process.env.MDR_LEGACY ? "typeof switchState === 'function' && !!window.mermaid && document.readyState === 'complete'" : "typeof switchState === 'function' && !!window.mermaid && typeof drawerOpen === 'boolean' && typeof themeChoice !== 'undefined' && document.getElementById('view-home') && !document.getElementById('view-home').classList.contains('hidden')";
    const ok = await waitFor(c, ready, 30000);
    if (!ok) throw new Error('页面没准备好');
    await c.ev(INSTRUMENT);
    c.errors.length = 0;
}
const J = v => JSON.stringify(v);
function dbJs(files, folders) {
    const db = { folders: [{ id: 'root', name: '默认文件夹', isOpen: true }, ...(folders || [])], files: files.map((f, i) => ({ timestamp: 1700000000000 + i * 1000, isPinned: false, folderId: 'root', ...f })) };
    return `localStorage.setItem('md-pro-db', ${J(JSON.stringify(db))})`;
}
const getDB = c => c.ev("JSON.parse(localStorage.getItem('md-pro-db'))");
async function dlgShown(c, ms = 3000) { return waitFor(c, "(() => { const o = document.querySelector('.dlg-overlay.show'); return o ? { title: (o.querySelector('.dlg-title')||{}).textContent || '', msg: (o.querySelector('.dlg-msg')||{}).textContent || '', btns: [...o.querySelectorAll('.dlg-btn')].map(b => b.textContent) } : null; })()", ms); }
async function dlgClick(c, text) {
    const d = await dlgShown(c);
    if (!d) return false;
    await c.ev(`[...document.querySelectorAll('.dlg-overlay.show .dlg-btn')].find(b => b.textContent === ${J(text)}).click()`);
    await sleep(300);
    return true;
}
async function openFromDrawer(c, title) {
    await c.ev("document.getElementById('btn-hamburger').click()");
    await sleep(350);
    await c.ev(`[...document.querySelectorAll('#history-list .history-info')].find(el => el.querySelector('.history-name, .history-title').textContent.trim() === ${J(title)}).click()`);
    await sleep(200);
}
const readerText = c => c.ev("document.getElementById('reader-content').innerText");
const state = c => c.ev('currentState');

async function caseRun(name, fn) {
    if (ONLY && !ONLY.test(name)) return;
    console.log('\n■ ' + name);
    try { await fn(); }
    catch (e) { check(name + '（用例异常）', false, e.message); }
}

(async () => {
    const srv = await serve(ROOT);
    BASE = `http://127.0.0.1:${srv.address().port}/`;
    console.log('被测：' + path.join(ROOT, 'index.html'));

    // ---------------- 手机 390 ----------------
    const m = await open(390, 844, 2);

    await caseRun('P1-0 Mermaid 公开漏洞（时序图标签 + $$）不再执行代码', async () => {
        // 照抄 GHSA-7rqq-prvp-x9jh 原文的 PoC，只把 document.write 换成计数（注意 $$\\text 是两个反斜杠）
        const poc = ['# 漏洞', '', '```mermaid', 'sequenceDiagram',
            '    participant A as Alice<img src="x" onerror="window.__xss1=(window.__xss1||0)+1">$$\\\\text{Alice}$$',
            '    A->>John: Hello John, how are you?', '    Alice-)John: See you later!', '```', ''].join('\n');
        await reset(m, dbJs([{ id: 'x', title: 'poc', content: poc }]));
        await openFromDrawer(m, 'poc');
        await sleep(3000);
        const x1 = await m.ev('window.__xss1 || 0');
        check('阅读页：onerror 没有执行', x1 === 0, { __xss1: x1 });
        await m.ev("switchState('edit')"); await m.ev("setEditTab('preview')"); await sleep(3000);
        const x2 = await m.ev('window.__xss1 || 0');
        check('编辑预览：onerror 也没有执行', x2 === 0, { __xss1: x2 });
        check('图正常画出来了（不是被报错挡住才「安全」的）', await m.ev("!!document.querySelector('#reader-content .mermaid svg')"));
        const scriptVer = await m.ev("[...document.scripts].map(s => s.src).find(s => s.includes('mermaid@'))");
        check('Mermaid 版本是 10.9.8', /mermaid@10\.9\.8\//.test(scriptVer), scriptVer);
        const mj = await m.ev("([...document.scripts].map(s => s.src).find(s => s.includes('mathjax@')) || '')");
        check('MathJax 钉死在 3.2.2（这篇里有 $$，会按需加载）', /mathjax@3\.2\.2\//.test(mj), mj);
        const dv = await m.ev('DOMPurify.version'); check('DOMPurify 版本是 3.4.16', dv === '3.4.16', dv);
    });

    await caseRun('XSS 回归：常见注入写法（正文 / 文件名）都不执行', async () => {
        const payloads = ['<img src=x onerror="window.__x2=1">', '<svg onload="window.__x2=1"></svg>', '<a href="javascript:window.__x2=1">点</a>', '<iframe srcdoc="<script>parent.__x2=1</script>"></iframe>', '<details open ontoggle="window.__x2=1">x</details>'];
        await reset(m, dbJs([{ id: 'x', title: '<img src=x onerror="window.__x3=1">', content: '# T\n\n' + payloads.join('\n\n') }]));
        await m.ev("document.getElementById('btn-hamburger').click()"); await sleep(300);
        await m.ev("document.querySelector('#history-list .history-info').click()"); await sleep(800);
        await m.ev("document.querySelector('#reader-content a[href]') && document.querySelector('#reader-content a[href]').click()");
        await m.ev("switchState('edit')"); await sleep(800);
        const r = await m.ev('[window.__x2 || 0, window.__x3 || 0]');
        check('正文、文件名里的注入都没执行', r[0] === 0 && r[1] === 0, r);
    });

    await caseRun('P1-1 编辑中换文档 / 新建：先问，不再悄悄丢', async () => {
        await reset(m, dbJs([{ id: 'a', title: '甲', content: '# 甲\n原文' }, { id: 'b', title: '乙', content: '# 乙\n乙文' }]));
        await openFromDrawer(m, '甲'); await sleep(600);
        await m.ev("switchState('edit')"); await sleep(600);
        await m.ev("editorTextarea.value += '\\n新加的一行'; editorTextarea.dispatchEvent(new Event('input'))");
        await openFromDrawer(m, '乙');
        const d = await dlgShown(m);
        check('侧边栏点别的文档：弹出「有未保存的修改」', d && d.title === '有未保存的修改', d);
        await dlgClick(m, '取消');
        check('选「取消」：仍在编辑页、内容还在', (await state(m)) === 'edit' && (await m.ev('editorTextarea.value')).includes('新加的一行'));
        await m.ev("document.getElementById('menu-new').click()");
        const d2 = await dlgShown(m);
        check('点「新建空白文档」也会先问', d2 && d2.title === '有未保存的修改', d2);
        await dlgClick(m, '取消');
        await openFromDrawer(m, '乙');
        await dlgClick(m, '保存');
        await sleep(800);
        const db = await getDB(m);
        check('选「保存」：甲存上了，然后打开了乙', db.files.find(f => f.id === 'a').content.includes('新加的一行') && (await state(m)) === 'read' && (await readerText(m)).includes('乙文'));
        const n = await m.ev('window.__native');
        check('全程没有用浏览器原生弹框', n.length === 0, n);
    });

    await caseRun('P1-2 两个页面同时开着：一边的旧数据不再整份冲掉另一边', async () => {
        await reset(m, dbJs([{ id: 'a', title: '甲', content: '# 甲\n第一版' }], [{ id: 'f1', name: '文件夹一', isOpen: false }]));
        // 本页先把侧边栏画出来（拿到旧数据）
        await m.ev("document.getElementById('btn-hamburger').click()"); await sleep(300);
        // 另一个页面（同源 iframe = 另一个应用实例）改库：甲改成第二版、新建丙
        await m.ev(`new Promise(r => { const f = document.createElement('iframe'); f.id = 'other'; f.style.cssText = 'position:fixed;left:-2000px;width:390px;height:600px'; f.src = location.href; f.onload = r; document.body.appendChild(f); })`);
        await waitFor(m, "(() => { try { return typeof document.getElementById('other').contentWindow.switchState === 'function'; } catch (e) { return false; } })()", 20000);
        await m.ev("document.getElementById('other').contentWindow.eval(\"mutateDB(db => { db.files.find(f => f.id === 'a').content = '# 甲\\\\n第二版'; }); createFile('丙', '# 丙')\")");
        await sleep(400);
        // 本页随手点一下文件夹标题
        await m.ev("[...document.querySelectorAll('#history-list .folder-info')].find(el => el.textContent.includes('文件夹一')).click()");
        await sleep(300);
        const db = await getDB(m);
        check('点文件夹后，另一边保存的「第二版」还在', db.files.find(f => f.id === 'a').content.includes('第二版'), db.files.map(f => f.title + ':' + f.content.slice(0, 8)));
        check('另一边新建的「丙」还在', db.files.some(f => f.title === '丙'));
        check('侧边栏已经自动刷新出「丙」', await m.ev("[...document.querySelectorAll('#history-list .history-name')].some(e => e.textContent === '丙')"));
        // 改名不被冲回：另一边改名，本页编辑甲后保存
        await m.ev("closeDrawer()"); await sleep(300);
        await openFromDrawer(m, '甲'); await sleep(500);
        await m.ev("switchState('edit')"); await sleep(400);
        await m.ev("document.getElementById('other').contentWindow.eval(\"mutateDB(db => { db.files.find(f => f.id === 'a').title = '甲改名'; })\")");
        await sleep(300);
        await m.ev("editorTextarea.value = '# 甲\\n第二版\\n本页加的'; editorTextarea.dispatchEvent(new Event('input'))");
        await m.ev('saveEdit()'); await sleep(800);
        const db2 = await getDB(m);
        const a = db2.files.find(f => f.id === 'a');
        check('另一边改的名字，本页保存后没被改回去', a.title === '甲改名' && a.content.includes('本页加的'), a);
        // 编辑冲突：本页编辑期间，另一边保存了同一篇
        await m.ev("switchState('edit')"); await sleep(400);
        await m.ev("document.getElementById('other').contentWindow.eval(\"mutateDB(db => { db.files.find(f => f.id === 'a').content = '另一边的第三版'; })\")");
        await sleep(300);
        await m.ev("editorTextarea.value += '\\n本页又加的'; editorTextarea.dispatchEvent(new Event('input'))");
        m.ev('saveEdit()');
        const d = await dlgShown(m);
        check('编辑期间别处保存过：保存时先问', d && d.title === '这篇文档在别处被改过', d);
        await dlgClick(m, '另存为新文档'); await sleep(800);
        const db3 = await getDB(m);
        check('选「另存为新文档」：两边的内容都留着', db3.files.find(f => f.id === 'a').content === '另一边的第三版' && db3.files.some(f => f.content.includes('本页又加的') && f.id !== 'a'));
    });

    await caseRun('P1-3 / O-1 备份与恢复、下载单篇 .md', async () => {
        await reset(m, dbJs([{ id: 'a', title: '甲', content: '# 甲' }, { id: 'b', title: '乙/斜杠:名', content: '# 乙' }], [{ id: 'f1', name: '文件夹一', isOpen: true }]));
        await m.ev("document.getElementById('btn-hamburger').click()"); await sleep(300);
        await m.ev("document.getElementById('menu-backup').click()"); await sleep(400);
        await m.ev("[...document.querySelectorAll('#action-menu .action-item')].find(e => e.textContent.includes('导出全部')).click()"); await sleep(400);
        const dl = await m.ev('window.__dl');
        const backup = dl.length ? await m.ev(`fetch(${J(dl[0].href)}).then(r => r.text())`) : '';
        let parsed = null; try { parsed = JSON.parse(backup); } catch (_) {}
        check('导出全部：下载了一个 .json 备份，里面有 2 篇文档和文件夹', dl.length === 1 && /\.json$/.test(dl[0].name) && parsed && parsed.db.files.length === 2 && parsed.db.folders.some(f => f.id === 'f1'), dl[0] && dl[0].name);
        // 下载单篇
        await m.ev(`[...document.querySelectorAll('#history-list .history-item')].find(e => e.textContent.includes('乙')).querySelector('.history-more-btn').click()`); await sleep(400);
        await m.ev("[...document.querySelectorAll('#action-menu .action-item')].find(e => e.textContent.includes('下载为')).click()"); await sleep(300);
        const dl2 = await m.ev('window.__dl');
        check('单篇下载为 .md，文件名里的非法字符换掉了', dl2.length === 2 && dl2[1].name === '乙_斜杠_名.md', dl2[1] && dl2[1].name);
        // 恢复：先删掉甲、改乙，再合并恢复
        await m.ev("mutateDB(db => { db.files = db.files.filter(f => f.id !== 'a'); db.files.find(f => f.id === 'b').content = '# 乙 新改的'; db.files.find(f => f.id === 'b').timestamp = Date.now() + 100000; })");
        await m.ev(`(() => { const f = new File([${J(backup)}], 'backup.json', { type: 'application/json' }); const dt = new DataTransfer(); dt.items.add(f); const i = document.getElementById('file-restore'); i.files = dt.files; i.dispatchEvent(new Event('change')); })()`);
        const d = await dlgShown(m);
        check('恢复前先问「合并 / 替换全部」', d && d.btns.includes('合并') && d.btns.includes('替换全部'), d);
        await dlgClick(m, '合并'); await sleep(500);
        const db = await getDB(m);
        check('合并：删掉的甲回来了，比备份新的乙保持不变', db.files.some(f => f.id === 'a') && db.files.find(f => f.id === 'b').content === '# 乙 新改的');
        // 坏文件
        await m.ev(`(() => { const f = new File(['不是 json'], 'x.json'); const dt = new DataTransfer(); dt.items.add(f); const i = document.getElementById('file-restore'); i.files = dt.files; i.dispatchEvent(new Event('change')); })()`);
        const d2 = await dlgShown(m);
        check('不是备份文件：提示，不改库', d2 && d2.title === '不是有效的备份文件', d2);
    });

    await caseRun('P2-1 Mermaid 写错：图的位置提示，目录照常更新、没有未接住的异常', async () => {
        await reset(m, dbJs([{ id: 'o', title: '旧文档', content: '# 旧文档的标题\n\n正文' }, { id: 'n', title: '坏图', content: '# 新文档的标题\n\n```mermaid\nflowchart LR\n  A --> \n  B -- -- >\n```\n\n## 第二节' }]));
        await openFromDrawer(m, '旧文档'); await sleep(800);
        await openFromDrawer(m, '坏图'); await sleep(2500);
        const toc = await m.ev("[...document.querySelectorAll('#toc-content .toc-link')].map(a => a.textContent)");
        check('目录是新文档的', toc[0] === '新文档的标题' && toc.includes('第二节'), toc);
        check('图的位置显示「图表语法有误」', await m.ev("!!document.querySelector('#reader-content .mermaid-error') && document.querySelector('#reader-content .mermaid-error').textContent.includes('图表语法有误')"));
        check('没有未接住的异常', m.errors.length === 0, m.errors.slice(0, 2));
        check('body 末尾没有留下 Mermaid 的临时错误元素', await m.ev("![...document.body.children].some(e => /^d?mermaid/.test(e.id))"));
    });

    await caseRun('P2-2 长公式不再撑宽整篇（390 宽）', async () => {
        const long = '$$' + Array.from({ length: 60 }, (_, i) => `x_{${i}}^2`).join('+') + '$$';
        await reset(m, dbJs([{ id: 'a', title: '公式', content: '# 公式\n\n' + long + '\n\n正文' }]));
        await openFromDrawer(m, '公式'); await waitFor(m, "!!document.querySelector('#reader-content mjx-container')", 20000); await sleep(500);
        const r = await m.ev("({ sw: document.getElementById('view-read').scrollWidth, cw: document.getElementById('view-read').clientWidth, kd: (() => { const k = document.querySelector('#reader-content .math-display'); return k ? [k.scrollWidth, k.clientWidth, getComputedStyle(k).overflowX] : null; })() })");
        check('阅读区没有横向溢出', r.sw <= r.cw, r);
        check('公式在自己的框里能左右滑', r.kd && r.kd[0] > r.kd[1] && r.kd[2] === 'auto', r.kd);
    });

    await caseRun('本站特有：四种定界符都渲染、金额不当公式、纯文字文档不加载 MathJax', async () => {
        const doc = ['# 公式', '', '行内 $E = mc^2$ 和 \\(a^2+b^2=c^2\\)。', '', '$$', '\\frac{1}{2}', '$$', '', '\\[ x = \\sqrt{2} \\]', '',
            '这本书 $25，那本 $30。', '', '花了 $5 和 $10 两笔。', '', '中文紧贴：面积是$\\pi r^2$平方米'].join('\n');
        await reset(m, dbJs([{ id: 'a', title: '公式', content: doc }, { id: 'b', title: '纯文字', content: '# 纯文字\n\n没有任何公式，价格 $5。' }]));
        await openFromDrawer(m, '纯文字'); await sleep(1500);
        check('纯文字文档：不加载 MathJax', !(await m.ev("!!(window.MathJax && window.MathJax.typesetPromise)")));
        await openFromDrawer(m, '公式');
        await waitFor(m, "document.querySelectorAll('#reader-content mjx-container').length >= 5", 20000);
        const r = await m.ev("({ n: document.querySelectorAll('#reader-content mjx-container').length, text: document.getElementById('reader-content').innerText })");
        check('$…$、\\(…\\)、$$…$$、\\[…\\]、中文紧贴的 $…$ 共 5 个公式都渲染了', r.n === 5, r.n);
        check('金额 $25 / $30、$5 和 $10 原样显示，没被当成公式', r.text.includes('$25') && r.text.includes('$30') && r.text.includes('$5') && r.text.includes('$10'), r.text.slice(0, 200));
        const sz = await m.ev("[...document.querySelectorAll('#reader-content mjx-container')].map(x => Math.round(x.getBoundingClientRect().width)).filter(w => w > 0).length");
        check('公式都有实际宽度（contain:layout 没把排版弄坏）', sz === 5, sz);
    });

    await caseRun('P2-3 文档里的 <style> / 固定定位不再影响整个应用', async () => {
        await reset(m, dbJs([{ id: 'a', title: '样式', content: '<style>header{background:olive!important}</style>\n\n# 样式\n\n段落\n\n<style>body{display:none}</style>\n\n<div style="position:fixed;inset:0;z-index:99999;background:red">盖住</div>\n\n<form action="https://example.com"><input name="p"></form>' }]));
        await openFromDrawer(m, '样式'); await sleep(800);
        const r = await m.ev("({ body: getComputedStyle(document.body).display, styles: document.querySelectorAll('#reader-content style').length, form: document.querySelectorAll('#reader-content form').length, headerHit: (() => { const h = document.getElementById('main-header').getBoundingClientRect(); const el = document.elementFromPoint(h.left + 30, h.top + h.height / 2); return !!(el && el.closest('header')); })() })");
        check('阅读页：<style> 被去掉，页面没白屏', r.body !== 'none' && r.styles === 0, r);
        check('position:fixed 的块盖不住顶栏', r.headerHit, r);
        check('<form> 被去掉', r.form === 0, r);
        await m.ev("switchState('edit')"); await m.ev("setEditTab('preview')"); await sleep(800);
        const r2 = await m.ev("({ body: getComputedStyle(document.body).display, styles: document.querySelectorAll('#editor-preview style').length })");
        check('编辑预览里也一样（<style> 在文档最开头）', r2.body !== 'none' && r2.styles === 0, r2);
    });

    await caseRun('P2-4 / P3-4 存储满：保存失败不改内存；导入/新建失败不假装成功', async () => {
        await reset(m, dbJs([{ id: 'a', title: '甲', content: '# 甲\n旧' }]));
        await openFromDrawer(m, '甲'); await sleep(500);
        await m.ev("switchState('edit')"); await sleep(400);
        await m.ev("window.__full = true; const _set = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (window.__full && k === 'md-pro-db') throw new DOMException('full', 'QuotaExceededError'); return _set.call(this, k, v); }");
        await m.ev("editorTextarea.value = '# 甲\\n新的没存上'; editorTextarea.dispatchEvent(new Event('input'))");
        m.ev('saveEdit()');
        const d = await dlgShown(m);
        check('保存失败有提示', d && d.title === '保存失败' && d.msg.includes('编辑框'), d);
        await dlgClick(m, '好');
        check('仍在编辑页，内存里的文档还是旧内容', (await state(m)) === 'edit' && (await m.ev('currentFile.content')) === '# 甲\n旧');
        m.ev('cancelEdit()'); await dlgClick(m, '放弃'); await sleep(600);
        check('放弃后阅读页显示的是库里的旧内容', (await readerText(m)).includes('旧') && !(await readerText(m)).includes('新的没存上'));
        await m.ev("switchState('edit')"); await sleep(300);
        await m.ev("editorTextarea.value += 'x'; editorTextarea.dispatchEvent(new Event('input'))");
        check('再进编辑改一下，关页面仍会拦', await m.ev('hasUnsavedEdit()'));
        m.ev('cancelEdit()'); await dlgClick(m, '放弃'); await sleep(400);
        // 导入失败
        await m.ev("switchState('home')"); await sleep(300);
        m.ev("processFileObj(new File(['# 导入的'], '导入.md'))");
        const d2 = await dlgShown(m);
        check('导入失败：提示说的是「没有存进来」，不是「还在编辑框里」', d2 && d2.msg.includes('没有存进来'), d2);
        await dlgClick(m, '好');
        check('导入失败后停在首页', (await state(m)) === 'home');
        await m.ev("window.__full = false");
    });

    await caseRun('P2-5 换文档从开头显示', async () => {
        const long = '# 长\n\n' + Array.from({ length: 200 }, (_, i) => `第 ${i} 段，` + '内容'.repeat(20)).join('\n\n');
        await reset(m, dbJs([{ id: 'a', title: '长', content: long }, { id: 'b', title: '另一篇', content: long.replace('# 长', '# 另一篇') }]));
        await openFromDrawer(m, '长'); await sleep(800);
        await m.ev("document.getElementById('view-read').scrollTop = 3000"); await sleep(300);
        await openFromDrawer(m, '另一篇'); await sleep(800);
        const top = await m.ev("document.getElementById('view-read').scrollTop");
        check('打开另一篇时 scrollTop = 0', top === 0, top);
    });

    await caseRun('O-3（按按钮）首页「继续阅读」+ 打开时「回到上次读到的位置」', async () => {
        const long = '# 长文\n\n' + Array.from({ length: 300 }, (_, i) => `## 第 ${i} 节\n\n` + '内容'.repeat(30)).join('\n\n');
        await reset(m, dbJs([{ id: 'a', title: '长文', content: long }, { id: 'b', title: '短', content: '# 短' }]));
        check('第一次打开是首页、没有「继续阅读」', (await state(m)) === 'home' && (await m.ev("document.getElementById('home-continue').children.length")) === 0);
        await openFromDrawer(m, '长文'); await sleep(900);
        // 模拟用户滚动
        await m.ev("const v = document.getElementById('view-read'); v.scrollTop = Math.round((v.scrollHeight - v.clientHeight) * 0.6); v.dispatchEvent(new Event('scroll'))");
        await sleep(700);
        const before = await m.ev("document.getElementById('view-read').scrollTop");
        await m.ev("document.getElementById('btn-back').click()"); await sleep(500);
        const label = await m.ev("document.getElementById('home-continue').textContent");
        check('回首页：出现「继续阅读 · 读到 60%」', /继续阅读 · 读到 (59|60|61)%/.test(label) && label.includes('长文'), label);
        // 刷新页面也还是首页
        await m.goto(BASE); await waitFor(m, "typeof switchState === 'function' && !!window.mermaid && typeof themeChoice !== 'undefined'"); await m.ev(INSTRUMENT);
        check('刷新后仍是首页（不自动跳）', (await state(m)) === 'home');
        await m.ev("document.querySelector('#home-continue .continue-btn').click()"); await sleep(1200);
        const after = await m.ev("document.getElementById('view-read').scrollTop");
        check('点「继续阅读」回到原来的位置', Math.abs(after - before) < 40, { before, after });
        // 从侧边栏打开：不自动跳，底部出现按钮
        await openFromDrawer(m, '短'); await sleep(600);
        await openFromDrawer(m, '长文'); await sleep(900);
        const pill = await m.ev("({ show: document.getElementById('resume-pill').classList.contains('show'), text: document.getElementById('resume-text').textContent, top: document.getElementById('view-read').scrollTop })");
        check('从侧边栏打开：停在开头，底部出现「回到上次读到的位置」', pill.show && pill.top === 0 && /回到上次读到的位置 · \d+%/.test(pill.text), pill);
        await m.ev("document.getElementById('resume-go').click()"); await sleep(400);
        const after2 = await m.ev("document.getElementById('view-read').scrollTop");
        check('点了才跳过去', Math.abs(after2 - before) < 40, { before, after2 });
        const fab = await m.ev("(() => { const a = document.getElementById('resume-pill').getBoundingClientRect(), b = document.getElementById('btn-fab-toc').getBoundingClientRect(); return a.right <= b.left || a.bottom <= b.top; })()");
        check('手机上按钮不压着右下角的目录按钮', fab);
    });

    await caseRun('O-2 自动草稿：误关页面后能找回', async () => {
        await reset(m, dbJs([{ id: 'a', title: '甲', content: '# 甲\n原文' }]));
        await openFromDrawer(m, '甲'); await sleep(500);
        await m.ev("switchState('edit')"); await sleep(400);
        await m.send('Runtime.evaluate', { expression: "editorTextarea.focus(); editorTextarea.setSelectionRange(editorTextarea.value.length, editorTextarea.value.length)" });
        await m.send('Input.insertText', { text: '\n草稿内容' });
        await sleep(1200);
        check('停顿后草稿已经存下', !!(await m.ev("localStorage.getItem('mdr-draft:a')")));
        m.beforeunloads.length = 0;
        await m.goto(BASE);
        check('有未保存修改时离开页面：浏览器会拦一下', m.beforeunloads.includes('beforeunload'), m.beforeunloads); await waitFor(m, "typeof switchState === 'function' && !!window.mermaid && typeof themeChoice !== 'undefined'"); await m.ev(INSTRUMENT);
        await openFromDrawer(m, '甲'); await sleep(600);
        check('重新打开：阅读页顶部提示有草稿', (await m.ev("document.getElementById('draft-bar-slot').textContent")).includes('未保存的草稿'));
        await m.ev("[...document.querySelectorAll('.draft-bar button')].find(b => b.textContent === '继续编辑').click()"); await sleep(700);
        check('点「继续编辑」：编辑框里是草稿内容', (await m.ev('editorTextarea.value')).includes('草稿内容') && (await m.ev('hasUnsavedEdit()')));
        await m.ev('saveEdit()'); await sleep(600);
        check('保存后草稿清掉', !(await m.ev("localStorage.getItem('mdr-draft:a')")));
    });

    await caseRun('O-6 手机上编辑 / 预览两个标签', async () => {
        await reset(m, dbJs([{ id: 'a', title: '甲', content: '# 甲\n\n正文' }]));
        await openFromDrawer(m, '甲'); await sleep(500);
        await m.ev("switchState('edit')"); await sleep(500);
        const r = await m.ev("({ tabs: getComputedStyle(document.querySelector('.edit-tabs')).display, prev: getComputedStyle(document.querySelector('.preview-pane')).display, editH: document.querySelector('.edit-pane').getBoundingClientRect().height, vh: innerHeight })");
        check('有两个标签，预览先藏着，编辑区接近整屏高', r.tabs === 'flex' && r.prev === 'none' && r.editH > r.vh * 0.75, r);
        await m.ev("editorTextarea.value += '\\n\\n新段落XYZ'; editorTextarea.dispatchEvent(new Event('input'))");
        await m.ev("document.getElementById('tab-preview').click()"); await sleep(700);
        const r2 = await m.ev("({ edit: getComputedStyle(document.querySelector('.edit-pane')).display, txt: document.getElementById('editor-preview').innerText })");
        check('切到「预览」：显示的是最新内容', r2.edit === 'none' && r2.txt.includes('新段落XYZ'), r2.edit);
    });

    await caseRun('O-7 侧边栏搜索', async () => {
        await reset(m, dbJs([{ id: 'a', title: '苹果', content: '# 苹果\n红色的水果' }, { id: 'b', title: '香蕉', content: '# 香蕉\n黄色的，跟苹果不一样' }, { id: 'c', title: '葡萄', content: '# 葡萄' }]));
        await m.ev("document.getElementById('btn-hamburger').click()"); await sleep(300);
        await m.ev("{ const i = document.getElementById('drawer-search-input'); i.value = '苹果'; i.dispatchEvent(new Event('input')); }"); await waitFor(m, "document.querySelectorAll('#history-list .history-name').length === 2", 3000);
        const names = await m.ev("[...document.querySelectorAll('#history-list .history-name')].map(e => e.textContent)");
        check('按标题和内容都能搜到，标题命中的排前面', J(names) === J(['苹果', '香蕉']), names);
        await m.ev("{ const i = document.getElementById('drawer-search-input'); i.value = '没有这个'; i.dispatchEvent(new Event('input')); }"); await waitFor(m, "document.getElementById('history-list').textContent.includes('没有找到')", 3000);
        check('搜不到时有提示', (await m.ev("document.getElementById('history-list').textContent")).includes('没有找到'));
    });

    await caseRun('O-10 / P3-3 / P3-13 导入：同名先问、不是文本拒绝、GBK 不乱码', async () => {
        await reset(m, dbJs([{ id: 'a', title: '笔记', content: '# 旧笔记' }]));
        m.ev("processFileObj(new File(['# 新笔记'], '笔记.md'))");
        const d = await dlgShown(m);
        check('同名：问「另存一份 / 覆盖原文档 / 取消」', d && d.title === '已有同名文档' && d.btns.length === 3, d);
        await dlgClick(m, '另存一份'); await sleep(800);
        let db = await getDB(m);
        check('另存一份：名字自动加 (2)', db.files.some(f => f.title === '笔记 (2)' && f.content === '# 新笔记'), db.files.map(f => f.title));
        m.ev("processFileObj(new File([new Uint8Array([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,0,0,0,0x0D,0x49,0x48,0x44,0x52])], '照片.jpg', { type: 'image/jpeg' }))");
        const d2 = await dlgShown(m);
        check('图片：拒绝并说明', d2 && d2.title === '不能打开这个文件', d2);
        await dlgClick(m, '好');
        m.ev("processFileObj(new File([new Uint8Array([0x89,0x50,0x4E,0x47,0,0,0,0])], '伪装.md'))");
        const d3 = await dlgShown(m);
        check('扩展名是 .md 但内容是二进制：也拒绝', d3 && d3.title === '不能打开这个文件', d3);
        await dlgClick(m, '好');
        db = await getDB(m);
        check('库里没多出乱码文档', db.files.length === 2, db.files.length);
        // GBK：「# 中文标题」
        m.ev("processFileObj(new File([new Uint8Array([0x23,0x20,0xD6,0xD0,0xCE,0xC4,0xB1,0xEA,0xCC,0xE2,0x0A])], 'gbk.md'))");
        await sleep(1200);
        check('GBK 编码的文件按 GBK 解出来', (await readerText(m)).includes('中文标题'), await readerText(m));
        // 一模一样的再导入一次：直接打开，不存第二份
        await m.ev("switchState('home')");
        m.ev("processFileObj(new File(['# 新笔记'], '笔记 (2).md'))"); await sleep(800);
        db = await getDB(m);
        check('一模一样的文件再导入：不重复存', db.files.filter(f => f.content === '# 新笔记').length === 1, db.files.map(f => f.title));
    });

    await caseRun('P3-1 外链新标签打开；P3-5 编辑预览里页内链接能跳', async () => {
        const body = '# 顶部\n\n[外链](https://example.com/a) 和 https://example.org 以及 [页内](#底部)\n\n' + Array.from({ length: 80 }, (_, i) => '段落 ' + i).join('\n\n') + '\n\n## 底部\n\n末尾[^1]\n\n' + Array.from({ length: 60 }, (_, i) => '后面的段落 ' + i).join('\n\n') + '\n\n[^1]: 脚注';
        await reset(m, dbJs([{ id: 'a', title: '链接', content: body }]));
        await openFromDrawer(m, '链接'); await sleep(800);
        const links = await m.ev("[...document.querySelectorAll('#reader-content a[href^=\"http\"]')].map(a => [a.target, a.rel])");
        check('外链都带 target=_blank rel=noopener', links.length >= 2 && links.every(l => l[0] === '_blank' && l[1].includes('noopener')), links);
        await m.ev("switchState('edit')"); await m.ev("setEditTab('preview')"); await sleep(800);
        await m.ev("document.querySelector('.preview-pane').scrollTop = 0; [...document.querySelectorAll('#editor-preview a')].find(a => a.textContent === '页内').click()"); await sleep(900);
        const r = await m.ev("(() => { const p = document.querySelector('.preview-pane'); const h = document.querySelector('#editor-preview #底部'); return { st: p.scrollTop, rel: h.getBoundingClientRect().top - p.getBoundingClientRect().top }; })()");
        check('编辑预览里点 [页内](#底部)：预览滚到那个标题', r.st > 0 && r.rel >= 0 && r.rel < 60, r);
    });

    await caseRun('P3-6 / P3-16 目录四级缩进、「暂无目录」对比度', async () => {
        await reset(m, dbJs([{ id: 'a', title: 'h', content: '# 一\n## 二\n### 三\n#### 四' }, { id: 'b', title: '无标题', content: '没有标题' }]));
        await openFromDrawer(m, 'h'); await sleep(600);
        const pads = await m.ev("[...document.querySelectorAll('#toc-content .toc-link')].map(a => parseFloat(getComputedStyle(a).paddingLeft))");
        check('一~四级缩进依次变深', pads.length === 4 && pads[0] < pads[1] && pads[1] < pads[2] && pads[2] < pads[3], pads);
        await openFromDrawer(m, '无标题'); await sleep(600);
        const ratio = await m.ev(`(() => { const el = document.querySelector('.toc-empty'); const c = getComputedStyle(el).color, b = getComputedStyle(document.getElementById('toc-sidebar')).backgroundColor;
            const rgb = s => s.match(/\\d+(\\.\\d+)?/g).slice(0, 3).map(Number); const L = a => { const [r, g, bb] = a.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * bb; };
            const l1 = L(rgb(c)), l2 = L(rgb(b)); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); })()`);
        check('「暂无目录」对比度 ≥ 4.5', ratio >= 4.5, ratio.toFixed(2));
        check('没有标题时手机上不显示目录按钮', await m.ev("document.getElementById('btn-fab-toc').classList.contains('hidden')"));
    });

    await caseRun('P3-7 / P3-9 手机：左边缘没有阴影带；目录按钮不挡文末', async () => {
        const long = '# 标题\n\n' + Array.from({ length: 60 }, (_, i) => '段落' + i).join('\n\n') + '\n\n最后一行文字';
        await reset(m, dbJs([{ id: 'a', title: '长', content: long }]));
        check('首页：收起的目录栏没有阴影', (await m.ev("getComputedStyle(document.getElementById('toc-sidebar')).boxShadow")) === 'none');
        await openFromDrawer(m, '长'); await sleep(700);
        await m.ev("const v = document.getElementById('view-read'); v.scrollTop = v.scrollHeight"); await sleep(300);
        const r = await m.ev("(() => { const last = document.getElementById('reader-content').lastElementChild.getBoundingClientRect(), fab = document.getElementById('btn-fab-toc').getBoundingClientRect(); return { lastBottom: last.bottom, fabTop: fab.top }; })()");
        check('滚到底：最后一行在目录按钮上方', r.lastBottom <= r.fabTop, r);
    });

    await caseRun('P3-8 侧边栏长名字：省略号、按钮不被挤出去', async () => {
        await reset(m, dbJs([{ id: 'a', title: '这是一个非常非常非常非常非常非常非常长的文件名字用来测试省略号', content: '# a' }], [{ id: 'f', name: 'Averyveryveryveryveryveryverylongenglishfoldernamewithoutspaces', isOpen: true }]));
        await m.ev("document.getElementById('btn-hamburger').click()"); await sleep(400);
        const r = await m.ev(`(() => { const n = document.querySelector('.history-name'); const dr = document.getElementById('drawer').getBoundingClientRect();
            const g = [...document.querySelectorAll('.folder-group')].find(x => x.dataset.id === 'f'); const acts = g.querySelector('.folder-actions').getBoundingClientRect(); const fname = g.querySelector('.folder-name');
            return { ell: getComputedStyle(n).textOverflow, clipped: n.scrollWidth > n.clientWidth, actsRight: acts.right, drawerRight: dr.right, fEll: getComputedStyle(fname).textOverflow, fclipped: fname.scrollWidth > fname.clientWidth }; })()`);
        check('长文件名显示省略号', r.ell === 'ellipsis' && r.clipped, r);
        check('长文件夹名不把按钮挤出侧边栏', r.actsRight <= r.drawerRight + 0.5 && r.fEll === 'ellipsis', r);
    });

    await caseRun('侧边栏手势：上下滑列表不会误关、左边缘上下滑不会误开；真横滑照常开关', async () => {
        // 2026-10-10 用户反馈：在抽屉靠右的半边上下滑看文件，会把抽屉关掉。原因是旧版只看横向位移，
        // 右手拇指上下滑是弧线、会往左偏 50px 以上。下面每一下都是真实触摸事件（CDP），走 11 个点。
        await reset(m, dbJs(Array.from({ length: 30 }, (_, i) => ({ id: 'g' + i, title: '文件' + i, content: '# ' + i }))));
        const swipe = async (x0, y0, x1, y1) => {
            await m.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
            for (let i = 1; i <= 10; i++) { await m.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (x1 - x0) * i / 10, y: y0 + (y1 - y0) * i / 10 }] }); await sleep(16); }
            await m.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await sleep(450);
        };
        await m.ev("document.getElementById('btn-hamburger').click()"); await sleep(400);
        const r = await m.ev("document.getElementById('drawer').getBoundingClientRect().right");
        await swipe(r - 30, 700, r - 110, 300);   // 拇指往上推，弧线左偏 80px
        check('抽屉右半边往上滑（左偏 80px）：不关', await m.ev('drawerOpen'));
        await swipe(r - 40, 300, r - 120, 650);   // 往下拉，同样左偏
        check('抽屉右半边往下滑（左偏 80px）：不关', await m.ev('drawerOpen'));
        await swipe(r - 30, 500, r - 110, 430);   // 斜着走、横竖差不多：拿不准就当滚动
        check('斜着滑（横 80 竖 70）：不关', await m.ev('drawerOpen'));
        await swipe(r - 30, 500, r - 160, 515);
        check('真往左横滑 130px：关上', !(await m.ev('drawerOpen')));
        await swipe(12, 300, 72, 700);            // 贴着左边缘往下滚正文，带一点右偏
        check('左边缘上下滑（右偏 60px）：不开', !(await m.ev('drawerOpen')));
        await swipe(12, 400, 160, 410);
        check('左边缘往右横滑：打开', await m.ev('drawerOpen'));
    });

    await caseRun('左边缘右滑的起点范围：正文左侧随手一划不开抽屉；宽表格里横滑不开', async () => {
        // 2026-10-10 用户反馈：触发范围太宽，左右滑动时经常把「我的文件」滑出来。旧版起点 < 40px 都算。
        const wide = '# 宽表\n\n| ' + Array.from({ length: 14 }, (_, i) => '第' + i + '列很长很长').join(' | ') + ' |\n|' + '---|'.repeat(14) + '\n| ' + Array.from({ length: 14 }, (_, i) => '内容' + i).join(' | ') + ' |\n\n' + Array.from({ length: 30 }, (_, i) => '段落' + i).join('\n\n');
        await reset(m, dbJs([{ id: 'a', title: '宽表', content: wide }]));
        await openFromDrawer(m, '宽表'); await sleep(700);
        const swipe = async (x0, y0, x1, y1) => {
            await m.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
            for (let i = 1; i <= 10; i++) { await m.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (x1 - x0) * i / 10, y: y0 + (y1 - y0) * i / 10 }] }); await sleep(16); }
            await m.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await sleep(450);
        };
        await swipe(30, 600, 180, 608);
        check('从 x=30 往右横滑 150px：不开（旧版会开）', !(await m.ev('drawerOpen')));
        await swipe(38, 600, 200, 590);
        check('从 x=38 往右横滑：不开', !(await m.ev('drawerOpen')));
        // 把表格滚到中间，再从它里面贴左的位置往右滑（= 想把表格滚回去）
        const t = await m.ev("(() => { const tb = document.querySelector('#reader-content table'); tb.scrollLeft = 200; const r = tb.getBoundingClientRect(); return { left: r.left, y: r.top + r.height / 2, scrollable: tb.scrollWidth > tb.clientWidth }; })()");
        if (t.left < 23) {
            await swipe(Math.max(t.left + 1, 6), t.y, 170, t.y + 4);
            check('起点在能横向滚动的表格里：不开', t.scrollable && !(await m.ev('drawerOpen')), t);
        } else {
            // 这个页面的正文左边距比触发区宽，表格够不到触发区；直接验那个判断函数
            check('能横向滚动的表格被认出来（正文边距 ' + Math.round(t.left) + 'px，表格本身够不到触发区）', t.scrollable && (await m.ev("inHScroller(document.querySelector('#reader-content table td')) && !inHScroller(document.querySelector('#reader-content p'))")), t);
        }
        await swipe(10, 600, 170, 606);
        check('真从屏幕边上（x=10）往右滑：照常打开', await m.ev('drawerOpen'));
    });

    await caseRun('手机编辑三种看法：编辑 / 分屏 / 预览，分屏上下各半屏且记得住', async () => {
        // 2026-10-10 用户要求：整屏编辑 / 整屏预览之外，把原来上下半屏同时看的方式加回来，三种自己切
        await reset(m, dbJs([{ id: 'a', title: '甲', content: '# 甲\n\n正文' }]));
        await openFromDrawer(m, '甲'); await sleep(500);
        await m.ev("switchState('edit')"); await sleep(500);
        const geo = "(() => { const e = document.querySelector('.edit-pane'), p = document.querySelector('.preview-pane'); const er = e.getBoundingClientRect(), pr = p.getBoundingClientRect(); return { ed: getComputedStyle(e).display, pd: getComputedStyle(p).display, eh: er.height, ph: pr.height, eb: er.bottom, pt: pr.top, vh: innerHeight, on: [...document.querySelectorAll('.edit-tabs button.on')].map(b => b.textContent), n: document.querySelectorAll('.edit-tabs button').length, over: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()";
        let r = await m.ev(geo);
        check('三个标签，默认是「编辑」整屏', r.n === 3 && r.on.join() === '编辑' && r.pd === 'none' && r.eh > r.vh * 0.75, r);
        await m.ev("document.getElementById('tab-split').click()"); await sleep(600);
        r = await m.ev(geo);
        check('点「分屏」：编辑在上、预览在下，各占三成以上屏高，不横向溢出', r.on.join() === '分屏' && r.ed !== 'none' && r.pd !== 'none' && r.eh > r.vh * 0.3 && r.ph > r.vh * 0.3 && r.pt >= r.eb - 1 && r.over <= 0, r);
        check('分屏时预览已经渲染出内容', (await m.ev("document.getElementById('editor-preview').innerText")).includes('正文'));
        await m.ev("editorTextarea.value += '\\n\\n新段落XYZ'; editorTextarea.dispatchEvent(new Event('input'))"); await sleep(700);
        check('分屏时打字：下半屏跟着更新', (await m.ev("document.getElementById('editor-preview').innerText")).includes('新段落XYZ'));
        await m.ev('saveEdit()'); await sleep(700);
        await m.ev("switchState('edit')"); await sleep(600);
        r = await m.ev(geo);
        check('保存后再进编辑：还是分屏', r.on.join() === '分屏' && r.pd !== 'none' && r.ed !== 'none', r);
        await m.ev("document.getElementById('tab-preview').click()"); await sleep(400);
        r = await m.ev(geo);
        check('点「预览」：整屏预览', r.on.join() === '预览' && r.ed === 'none' && r.ph > r.vh * 0.75, r);
        await m.ev("document.getElementById('tab-edit').click()"); await sleep(300);
        await m.ev("switchState('read')"); await sleep(500); await m.ev("switchState('edit')"); await sleep(500);
        r = await m.ev(geo);
        check('改回「编辑」后再进：是整屏编辑', r.on.join() === '编辑' && r.pd === 'none', r);
    });

    await caseRun('进编辑页（分屏）：预览跟编辑框一样从开头显示，点了编辑框才跟光标', async () => {
        // 2026-10-10 发现：填内容后光标默认在最末尾，预览跟着光标滚到文末，编辑框却在开头，上下对不上
        const long = '# 标题\n\n' + Array.from({ length: 80 }, (_, i) => '第 ' + (i + 1) + ' 段正文。').join('\n\n');
        await reset(m, dbJs([{ id: 'a', title: '长文', content: long }]) + "; localStorage.setItem('mdr-edit-tab', 'split')");
        await openFromDrawer(m, '长文'); await sleep(600);
        await m.ev("switchState('edit')"); await sleep(1200);
        const r = await m.ev("({ split: document.getElementById('view-edit').classList.contains('tab-split'), ed: editorTextarea.scrollTop, pv: document.querySelector('.preview-pane').scrollTop, txt: document.getElementById('editor-preview').innerText.length })");
        check('一进来就是分屏，预览已渲染且停在开头', r.split && r.txt > 100 && r.ed === 0 && r.pv === 0, r);
        await m.ev("{ const v = editorTextarea.value, i = v.indexOf('第 60 段'); editorTextarea.focus(); editorTextarea.setSelectionRange(i, i); editorTextarea.dispatchEvent(new MouseEvent('click', { bubbles: true })); }"); await sleep(500);
        const pv = await m.ev("document.querySelector('.preview-pane').scrollTop");
        check('点到第 60 段：预览跟过去', pv > 500, pv);
    });

    await caseRun('手机编辑页底部一排：放弃 / 重置 / 保存，三个一样大，不再收在 ⋯ 里', async () => {
        // 2026-10-10 用户：常用按钮别放右上角三个点的二级菜单里，容易忽略、找不到。选了「底部一排」，去掉深色按钮
        await reset(m, dbJs([{ id: 'a', title: '甲', content: '# 甲\n\n原文' }]));
        await openFromDrawer(m, '甲'); await sleep(500);
        await m.ev("switchState('edit')"); await sleep(500);
        const geo = "(() => { const bar = document.querySelector('.edit-bar'); if (!bar) return { bs: [], more: true }; const bs = [...bar.querySelectorAll('button')].map(b => { const r = b.getBoundingClientRect(), f = b.querySelector('.face').getBoundingClientRect(); return { t: b.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height), fh: Math.round(f.height), fw: Math.round(f.width), bottom: r.bottom, left: r.left, right: r.right }; }); const vis = id => { const el = document.getElementById(id); return !!el && el.getBoundingClientRect().width > 0; }; return { bs, vh: innerHeight, vw: document.documentElement.clientWidth, more: vis('btn-edit-more'), theme: vis('btn-theme'), over: document.documentElement.scrollWidth - document.documentElement.clientWidth, paneBottom: document.querySelector('.edit-pane').getBoundingClientRect().bottom, barTop: bar.getBoundingClientRect().top }; })()";
        for (const tab of ['edit', 'split', 'preview']) {
            await m.ev("setEditTab('" + tab + "')"); await sleep(300);
            const r = await m.ev(geo);
            const same = r.bs.length === 3 && r.bs.every(b => b.w === r.bs[0].w && b.h === r.bs[0].h && b.fh === r.bs[0].fh && b.fw === r.bs[0].fw);
            check('「' + tab + '」下：底部三个按钮（放弃 / 重置 / 保存）一样大、点击高度 ≥44、都在屏幕内', r.bs.map(b => b.t).join() === '放弃,重置,保存' && same && r.bs[0].h >= 44 && r.bs.every(b => b.bottom <= r.vh && b.left >= 0 && b.right <= r.vw) && r.over <= 0, r.bs);
            if (tab === 'edit') check('右上角没有 ⋯，这个界面也没有深色按钮；按钮排在编辑区下面不盖字', !r.more && !r.theme && r.barTop >= r.paneBottom - 1, { more: r.more, theme: r.theme, barTop: r.barTop, paneBottom: r.paneBottom });
        }
        await m.ev("setEditTab('edit')");
        await m.ev("editorTextarea.value = '# 甲\\n\\n改过了'; editorTextarea.dispatchEvent(new Event('input'))"); await sleep(200);
        m.ev("document.getElementById('bar-edit-reset').click()");
        check('点「重置」：先问一句', !!(await dlgShown(m)));
        await dlgClick(m, '恢复'); await sleep(300);
        check('确认后编辑框回到原文', (await m.ev('editorTextarea.value')) === '# 甲\n\n原文');
        await m.ev("editorTextarea.value = '# 甲\\n\\n存这个'; editorTextarea.dispatchEvent(new Event('input'))"); await sleep(200);
        await m.ev("document.getElementById('bar-edit-save').click()"); await sleep(800);
        check('点「保存」：存进库并回到阅读', (await state(m)) === 'read' && (await getDB(m)).files[0].content === '# 甲\n\n存这个');
        await m.ev("switchState('edit')"); await sleep(400);
        await m.ev("editorTextarea.value = '# 甲\\n\\n不要这个'; editorTextarea.dispatchEvent(new Event('input'))"); await sleep(200);
        m.ev("document.getElementById('bar-edit-cancel').click()");
        const d = await dlgShown(m);
        check('点「放弃」且有改动：先问', !!d, d);
        if (d) { await m.ev("[...document.querySelectorAll('.dlg-overlay.show .dlg-btn')].find(b => /放弃|不保存|丢弃/.test(b.textContent)).click()"); await sleep(700); }
        check('确认后回到阅读，库里还是上次保存的', (await state(m)) === 'read' && (await getDB(m)).files[0].content === '# 甲\n\n存这个', d && d.btns);
    });

    await caseRun('P3-11 侧边栏关上后马上再打开：遮罩还在、点空白能关', async () => {
        await reset(m, '');
        await m.ev("document.getElementById('btn-hamburger').click()"); await sleep(400);
        await m.ev("document.getElementById('overlay').click()"); await sleep(100);
        await m.ev("document.getElementById('btn-hamburger').click()"); await sleep(500);
        const vis = await m.ev("getComputedStyle(document.getElementById('overlay')).display");
        check('0.3 秒内重开：遮罩仍显示', vis === 'block', vis);
        await m.ev("document.getElementById('overlay').click()"); await sleep(400);
        check('点遮罩能关上', !(await m.ev('drawerOpen')));
    });

    await caseRun('P3-12 文档里的 id="history-list" 不再把文件列表画进正文', async () => {
        await reset(m, dbJs([{ id: 'a', title: '撞 id', content: '# 撞\n\n<div id="history-list">文档里的</div>' }]));
        await openFromDrawer(m, '撞 id'); await sleep(600);
        await m.ev("document.getElementById('btn-hamburger').click()"); await sleep(400);
        // 让侧边栏重画两次（点两下文件夹标题：展开再收起），重画时才会去找 #history-list
        for (let k = 0; k < 2; k++) { await m.ev("document.querySelector('#drawer .folder-info').click()"); await sleep(250); }
        const r = await m.ev("({ inDoc: document.querySelector('#reader-content #history-list').children.length, inDrawer: document.querySelector('#drawer #history-list').children.length })");
        check('文件列表画在侧边栏里，正文里那个没被动', r.inDoc === 0 && r.inDrawer > 0, r);
    });

    await caseRun('P3-14 / O-11 示例：改过的不被改回去；内容是功能展示；不再跟 markdown-reader 的示例互相覆盖', async () => {
        // 库里已有 markdown-reader 的示例（id 也叫 sample）：本站点「示例」不能把它覆盖掉
        await reset(m, dbJs([{ id: 'sample', title: 'markdown-reader 的示例', content: '# 那边的示例' }]));
        await m.ev("document.getElementById('btn-home-sample').click()");
        await waitFor(m, "document.querySelectorAll('#reader-content mjx-container').length >= 8 && !!document.querySelector('#reader-content .mermaid svg')", 30000);
        const r = await m.ev("({ mermaid: !!document.querySelector('#reader-content .mermaid svg'), math: document.querySelectorAll('#reader-content mjx-container').length, fn: !!document.querySelector('#reader-content .footnotes'), alert: !!document.querySelector('#reader-content .markdown-alert'), table: !!document.querySelector('#reader-content table') })");
        check('示例是功能展示（图、公式、脚注、提示框、表格都有）', r.mermaid && r.math >= 8 && r.fn && r.alert && r.table, r);
        const other = (await getDB(m)).files.find(f => f.id === 'sample');
        check('markdown-reader 的示例没被覆盖', other && other.content === '# 那边的示例', other);
        await m.ev("mutateDB(db => { db.files.find(f => f.id === 'sample-math').content = '# 我改过的示例'; })");
        await m.ev("switchState('home')"); await m.ev("document.getElementById('btn-home-sample').click()"); await sleep(800);
        check('改过的示例再点「示例」：还是改过的', (await readerText(m)).includes('我改过的示例'));
    });

    await caseRun('P3-17 数据损坏且备份写不进去：如实说明、暂停保存', async () => {
        await m.goto(BASE);
        await m.ev("localStorage.clear(); localStorage.setItem('md-pro-db', '{坏的 json'); true");
        await m.send('Page.addScriptToEvaluateOnNewDocument', { source: "if (location.hash !== '#noblock') { const _s = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (String(k).startsWith('md-pro-db-corrupt-backup')) throw new DOMException('full', 'QuotaExceededError'); return _s.call(this, k, v); }; }" });
        await m.goto(BASE);
        await waitFor(m, "typeof switchState === 'function' && typeof themeChoice !== 'undefined'", 20000);
        const d = await dlgShown(m, 5000);
        check('提示说「没能另存备份」而不是「已另存」', d && d.msg.includes('没能另存备份'), d);
        await dlgClick(m, '稍后');
        await m.ev("mutateDB(db => { db.folders.push({ id: 'z', name: 'z' }); })");
        check('下载原始数据之前不会覆盖损坏的原文', (await m.ev("localStorage.getItem('md-pro-db')")) === '{坏的 json');
        await dlgClick(m, '稍后');
    });

    // ---- 以下几条来自 2026-10-09 对整改提交跑的 /code-review，每条都在整改后、复审修复前的版本（9e16309）上确认过会红 ----
    await caseRun('复审-1/2 数据损坏：下载原始数据后能继续保存；同一份损坏内容不重复备份', async () => {
        const m3 = await open(390, 844, 2);
        try {
            // (2) 已有一份内容不同的旧备份：反复读库，不该每次都再写一份整库副本
            await m3.goto(BASE);
            await m3.ev("localStorage.clear(); localStorage.setItem('md-pro-db-corrupt-backup', '旧的另一份'); localStorage.setItem('md-pro-db', '{这次坏的'); true");
            await m3.goto(BASE);
            await waitFor(m3, "typeof switchState === 'function' && typeof drawerOpen === 'boolean' && typeof themeChoice !== 'undefined'", 20000);
            await dlgClick(m3, '稍后');
            await m3.ev("for (let i = 0; i < 5; i++) getDB(); renderDrawer(); true");
            const n = await m3.ev("Object.keys(localStorage).filter(k => k.startsWith('md-pro-db-corrupt-backup')).length");
            check('反复读库：只多出 1 份备份（旧的 + 这次的 = 2）', n === 2, n);
            // (1) 备份写不进去 → 下载原始数据 → 之后能正常保存
            await m3.ev("localStorage.clear(); localStorage.setItem('md-pro-db', '{又坏了'); true");
            await m3.send('Page.addScriptToEvaluateOnNewDocument', { source: "{ const _s = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (String(k).startsWith('md-pro-db-corrupt-backup')) throw new DOMException('full', 'QuotaExceededError'); return _s.call(this, k, v); }; }" });
            await m3.goto(BASE);
            await waitFor(m3, "typeof switchState === 'function' && typeof drawerOpen === 'boolean' && typeof themeChoice !== 'undefined'", 20000);
            await m3.ev(INSTRUMENT);
            await dlgClick(m3, '下载原始数据');
            await dlgClick(m3, '已经存好');
            check('下载到了原始数据', (await m3.ev('window.__dl.length')) === 1);
            await m3.ev("mutateDB(db => { db.folders.push({ id: 'z', name: '新建的', isOpen: true }); })"); await sleep(300);
            const after = await m3.ev("(() => { try { return JSON.parse(localStorage.getItem('md-pro-db')).folders.some(f => f.id === 'z'); } catch (e) { return false; } })()");
            const again = await dlgShown(m3, 800);
            check('下载之后保存成功，不再反复弹「数据损坏」', after && !again, { after, again });
            // 损坏 + 没备份上 → 选「稍后」→ 另一个标签页把库修好了 → 这边应该能正常保存了（第三轮复审）
            await m3.ev("localStorage.setItem('md-pro-db', '{第三次坏'); true");
            await m3.goto(BASE);
            await waitFor(m3, "typeof switchState === 'function' && typeof drawerOpen === 'boolean' && typeof themeChoice !== 'undefined'", 20000);
            await dlgClick(m3, '稍后');
            await m3.ev(`localStorage.setItem('md-pro-db', ${J(JSON.stringify({ folders: [{ id: 'root', name: '默认文件夹', isOpen: true }], files: [] }))}); true`);
            await m3.ev("mutateDB(db => { db.folders.push({ id: 'y', name: '修好后建的', isOpen: true }); })"); await sleep(300);
            const fixed = await m3.ev("(() => { try { return JSON.parse(localStorage.getItem('md-pro-db')).folders.some(f => f.id === 'y'); } catch (e) { return false; } })()");
            check('别处把库修好后，这边能正常保存、不再弹损坏提示', fixed && !(await dlgShown(m3, 800)), fixed);
        } finally { m3.close(); }
    });

    await caseRun('复审-3 换文档时，上一篇读到的位置不会记到新那篇头上', async () => {
        const long = t => `# ${t}\n\n` + Array.from({ length: 200 }, (_, i) => `## 第 ${i} 节\n\n` + '内容'.repeat(30)).join('\n\n');
        await reset(m, dbJs([{ id: 'a', title: '甲', content: long('甲') }, { id: 'b', title: '乙', content: long('乙') }])
            + "; localStorage.setItem('mf-read-pos', JSON.stringify({ a: { i: 100, f: 0.1, n: 401, r: 0.5, t: 1 } })); localStorage.setItem('mf-last-doc', 'a')");
        await m.ev("document.querySelector('#home-continue .continue-btn').click()"); await sleep(1500);
        // 在甲里滚一下，400ms 的「记位置」计时还没到就换到乙（用户读着读着马上点了另一篇）
        await m.ev("{ const v = document.getElementById('view-read'); v.scrollTop += 600; v.dispatchEvent(new Event('scroll')); openDoc('b'); }");
        await sleep(1500);
        const r = await m.ev("({ posA: (JSON.parse(localStorage.getItem('mf-read-pos') || '{}').a || {}).r, posB: JSON.parse(localStorage.getItem('mf-read-pos') || '{}').b || null, pill: document.getElementById('resume-pill').classList.contains('show') })");
        check('乙没有被记上甲的位置、也没有冒出假的「回到上次位置」', !r.posB && !r.pill, r);
        check('甲这次滚到的新位置记在甲自己名下', typeof r.posA === 'number' && r.posA !== 0.5, r.posA);
    });

    await caseRun('复审-4 删除类确认框：回车默认是「取消」', async () => {
        await reset(m, dbJs([{ id: 'a', title: '甲', content: '# 甲' }]));
        await m.ev("document.getElementById('btn-hamburger').click()"); await sleep(300);
        await m.ev("document.querySelector('#history-list .history-more-btn').click()"); await sleep(400);
        await m.ev("[...document.querySelectorAll('#action-menu .action-item')].find(e => e.textContent.includes('删除文档')).click()"); await sleep(400);
        const focused = await m.ev("document.activeElement && document.activeElement.textContent");
        check('焦点在「取消」上，不在红色「删除」上', focused === '取消', focused);
        await m.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await sleep(400);
        check('按回车没有删掉文档', (await getDB(m)).files.length === 1);
    });

    await caseRun('复审-5 选了「不保存」但后面又取消：草稿还在', async () => {
        await reset(m, dbJs([{ id: 'a', title: '甲', content: '# 甲' }]));
        await openFromDrawer(m, '甲'); await sleep(500);
        await m.ev("switchState('edit')"); await sleep(400);
        await m.ev("editorTextarea.value += '\\n要留住的修改'; editorTextarea.dispatchEvent(new Event('input')); saveDraftNow(); true");
        await m.ev("document.getElementById('btn-hamburger').click()"); await sleep(300);
        m.ev("document.getElementById('menu-new').click()");
        await dlgClick(m, '不保存');
        await dlgClick(m, '取消');   // 新建文档的名字框点取消
        const r = await m.ev("({ st: currentState, draft: !!localStorage.getItem('mdr-draft:a'), val: editorTextarea.value.includes('要留住的修改') })");
        check('还在编辑页、修改还在、草稿没被删', r.st === 'edit' && r.val && r.draft, r);
        // 真正离开编辑页时才删草稿
        // 半路放弃之后改动还在：下一次离开必须重新问（2026-10-09 第二轮复审：原来不再问，直接扔掉了改动和草稿）
        await openFromDrawer(m, '甲');
        const asked = await dlgShown(m);
        check('半路放弃后再离开：仍然先问「有未保存的修改」', asked && asked.title === '有未保存的修改', asked);
        check('关页面也仍然会拦', await m.ev('hasUnsavedEdit()'));
        check('点到了「不保存」', await dlgClick(m, '不保存')); await sleep(600);
        check('真正离开编辑页后草稿才删掉', !(await m.ev("localStorage.getItem('mdr-draft:a')")) && (await state(m)) === 'read');
    });

    await caseRun('复审-7 搜索摘要按原文位置截取（前面有变长字符也不歪）', async () => {
        await reset(m, dbJs([{ id: 'a', title: '甲', content: 'İİİİİİİİİİİİİİİİİİİİ 前文 关键词ABC 后文' }]));
        await m.ev("document.getElementById('btn-hamburger').click()"); await sleep(300);
        await m.ev("{ const i = document.getElementById('drawer-search-input'); i.value = '关键词abc'; i.dispatchEvent(new Event('input')); }"); await waitFor(m, "!!document.querySelector('.history-snippet')", 3000);
        const snip = await m.ev("(document.querySelector('.history-snippet') || {}).textContent || ''");
        check('摘要里包含完整的关键词', snip.includes('关键词ABC'), snip);
        // 大小写不同也能搜到（abc 搜出 ABC）已经在上一条里覆盖了
    });

    await caseRun('复审-10 测试用的本地服务器不能读到被测目录以外的文件', async () => {
        // 自己搭一个确定存在的场景：临时目录里放 site/index.html 和隔壁的 secret.txt，对 site 起一个服务器，
        // 用 %2f 编码的 ../ 去读 secret.txt（%2f 不会被 URL 解析器提前规整掉，到了服务器解码后才变成 ../）。
        const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mdr-trav-'));
        const site = path.join(tmp, 'site');
        fs.mkdirSync(site); fs.writeFileSync(path.join(site, 'index.html'), 'ok'); fs.writeFileSync(path.join(tmp, 'secret.txt'), 'SECRET');
        const s2 = await serve(site);
        const b2 = `http://127.0.0.1:${s2.address().port}`;
        const get = async p => { try { const r = await fetch(b2 + p); return { status: r.status, body: await r.text() }; } catch (e) { return { status: 'err', body: '' }; } };
        try {
            const normal = await get('/index.html');
            check('对照：被测目录里的文件能正常读到', normal.status === 200 && normal.body === 'ok', normal.status);
            const out = await get('/..%2fsecret.txt');
            check('/..%2fsecret.txt 读不到隔壁的文件（403）', out.status === 403 && !out.body.includes('SECRET'), out.status);
            const nul = await get('/index.html%00');
            const alive = await get('/index.html');
            check('路径里带 %00：返回 400，服务器没被带崩', nul.status === 400 && alive.status === 200, [nul.status, alive.status]);
        } finally { s2.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
    });

    // ---- 2026-10-09 对数学公式阅读器同步改动跑 /code-review 找出的（共用代码，两站一起修） ----
    await caseRun('复审4-1 数据损坏：下载后要确认存好了才解除保护', async () => {
        const m4 = await open(390, 844, 2);
        try {
            await m4.goto(BASE);
            await m4.ev("localStorage.clear(); localStorage.setItem('md-pro-db', '{坏了'); true");
            await m4.send('Page.addScriptToEvaluateOnNewDocument', { source: "{ const _s = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (String(k).startsWith('md-pro-db-corrupt-backup')) throw new DOMException('full', 'QuotaExceededError'); return _s.call(this, k, v); }; }" });
            await m4.goto(BASE);
            await waitFor(m4, "typeof switchState === 'function' && typeof themeChoice !== 'undefined'", 20000);
            await m4.ev(INSTRUMENT);
            await dlgClick(m4, '下载原始数据');
            const d2 = await dlgShown(m4);
            check('下载后先问「原始数据存好了吗」', d2 && d2.title === '原始数据存好了吗？', d2);
            await dlgClick(m4, '还没有');
            await m4.ev("mutateDB(db => { db.folders.push({ id: 'z', name: 'z' }); })"); await sleep(300);
            check('选「还没有」：仍然不会覆盖损坏的原文', (await m4.ev("localStorage.getItem('md-pro-db')")) === '{坏了');
        } finally { m4.close(); }
    });

    await caseRun('复审4-2 「回到上次位置」先随手滑一下再点：仍跳到上次的位置', async () => {
        const long = '# 长文\n\n' + Array.from({ length: 200 }, (_, i) => `## 第 ${i} 节\n\n` + '内容'.repeat(30)).join('\n\n');
        await reset(m, dbJs([{ id: 'a', title: '长文', content: long }]));
        await openFromDrawer(m, '长文'); await sleep(900);
        await m.ev("{ const v = document.getElementById('view-read'); v.scrollTop = Math.round((v.scrollHeight - v.clientHeight) * 0.6); v.dispatchEvent(new Event('scroll')); }"); await sleep(800);
        const target = await m.ev("document.getElementById('view-read').scrollTop");
        await m.ev("switchState('home')"); await sleep(300);
        await openFromDrawer(m, '长文'); await sleep(900);
        // 按钮出来之后，用户先往下滑了一点（够让「读到哪」重新记一次）
        await m.ev("{ const v = document.getElementById('view-read'); v.scrollTop = 200; v.dispatchEvent(new Event('scroll')); }"); await sleep(800);
        await m.ev("document.getElementById('resume-go').click()"); await sleep(400);
        const after = await m.ev("document.getElementById('view-read').scrollTop");
        check('跳到的是按钮上写的那个位置', Math.abs(after - target) < 40, { target, after });
    });

    await caseRun('复审4-3 共用的草稿：别处写的草稿，这边没改就离开时不删', async () => {
        await reset(m, dbJs([{ id: 'a', title: '甲', content: '# 甲' }]));
        await openFromDrawer(m, '甲'); await sleep(500);
        await m.ev("switchState('edit')"); await sleep(500);
        // 进了编辑页之后，另一个标签页（或姊妹站）给同一篇写了它自己的草稿
        await m.ev("localStorage.setItem('mdr-draft:a', JSON.stringify({ content: '# 甲\\n别处的草稿', base: '# 甲', title: '甲', at: Date.now() })); true");
        await m.ev("document.dispatchEvent(new Event('visibilitychange')); saveDraftNow(); true");
        check('切后台（内容没改）：别处的草稿还在', !!(await m.ev("localStorage.getItem('mdr-draft:a')")));
        await m.ev("switchState('read')"); await sleep(500);
        check('什么都没改就离开编辑页：别处的草稿还在', !!(await m.ev("localStorage.getItem('mdr-draft:a')")));
    });

    await caseRun('复审4-5/6 弹框开着时 Ctrl+S 不弹浏览器另存；弹框关掉后不挡点击', async () => {
        await reset(m, dbJs([{ id: 'a', title: '甲', content: '# 甲' }]));
        m.ev("showAlert('标题', '内容')");
        await dlgShown(m);
        const prevented = await m.ev("(() => { const t = document.activeElement || document.body; const e = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }); t.dispatchEvent(e); return e.defaultPrevented; })()");
        check('弹框开着时按 Ctrl+S：默认动作（网页另存为）被拦下', prevented === true, prevented);
        await m.ev("document.querySelector('.dlg-overlay.show .dlg-btn').click()");
        const pe = await m.ev("(() => { const o = document.querySelector('.dlg-overlay'); return o ? getComputedStyle(o).pointerEvents : 'gone'; })()");
        check('弹框关掉、还在淡出时：遮罩不挡点击', pe === 'none' || pe === 'gone', pe);
    });

    await caseRun('复审4-8 库里混进 null 条目：侧边栏照常显示', async () => {
        await reset(m, "localStorage.setItem('md-pro-db', JSON.stringify({ folders: [null, { id: 'root', name: '默认文件夹', isOpen: true }, 5], files: [null, { id: 'a', title: '甲', content: '# 甲', timestamp: 1, folderId: 'root' }, 'x'] }))");
        await m.ev("document.getElementById('btn-hamburger').click()"); await sleep(400);
        const names = await m.ev("[...document.querySelectorAll('#history-list .history-name')].map(e => e.textContent)");
        check('侧边栏显示出「甲」，没有报错', J(names) === J(['甲']) && m.errors.length === 0, { names, errors: m.errors.slice(0, 2) });
    });

    await caseRun('P3-18 文件夹拖动：往下拖插到后面（触屏长按）', async () => {
        const m2 = await open(390, 844, 2);
        try {
            await reset(m2, dbJs([], [{ id: 'f1', name: 'F1', isOpen: false }, { id: 'f2', name: 'F2', isOpen: false }, { id: 'f3', name: 'F3', isOpen: false }]));
            await m2.ev("document.getElementById('btn-hamburger').click()"); await sleep(400);
            const pos = await m2.ev("(() => { const g = id => document.querySelector(`.folder-group[data-id=\"${id}\"] .folder-header`).getBoundingClientRect(); const a = g('f1'), c = g('f3'); return { x: a.left + 60, y: a.top + a.height / 2, ty: c.top + c.height / 2 }; })()");
            await m2.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pos.x, y: pos.y }] });
            await sleep(650);
            for (let i = 1; i <= 8; i++) { await m2.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: pos.x, y: pos.y + (pos.ty - pos.y) * i / 8 }] }); await sleep(30); }
            const mark = await m2.ev("document.querySelector('.folder-group[data-id=\"f3\"]').className");
            await m2.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await sleep(500);
            const order = (await getDB(m2)).folders.map(f => f.id);
            check('拖动时蓝线画在目标下方', /drag-after/.test(mark), mark);
            check('松手后 F1 排到 F3 后面', J(order) === J(['root', 'f2', 'f3', 'f1']), order);
        } finally { m2.close(); }
    });

    await caseRun('O-8 / O-13 / 8.1 原生弹框、触摸区域、按钮对比度', async () => {
        await reset(m, dbJs([{ id: 'a', title: '甲', content: '# 甲' }]));
        const green = await m.ev(`(() => { const el = document.querySelector('.btn-upload-lg'); const rgb = s => s.match(/\\d+(\\.\\d+)?/g).slice(0, 3).map(Number);
            const L = a => { const [r, g, b] = a.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
            const l1 = L(rgb(getComputedStyle(el).color)), l2 = L(rgb(getComputedStyle(el).backgroundColor)); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); })()`);
        check('首页「打开 MD 文件」白字对比度 ≥ 4.5', green >= 4.5, green.toFixed(2));
        await openFromDrawer(m, '甲'); await sleep(500);
        await m.ev("document.getElementById('btn-hamburger').click()"); await sleep(400);
        const small = await m.ev(`[...document.querySelectorAll('header button, #drawer button, .history-more-btn')].filter(b => b.offsetParent).map(b => { const r = b.getBoundingClientRect(); return { id: b.id || b.className, w: Math.round(r.width), h: Math.round(r.height) }; }).filter(r => r.h < 44 || r.w < 36)`);
        check('顶栏、侧边栏里看得见的按钮都 ≥ 44 高（≥ 36 宽）', small.length === 0, small);
        const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
        const nat = (src.match(/[^.\w](alert|confirm|prompt)\(/g) || []);
        check('源码里不再调用 alert / confirm / prompt', nat.length === 0, nat);
    });

    await caseRun('O-12 没手动选过时跟随系统深浅色', async () => {
        await reset(m, '');
        await m.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }); await sleep(300);
        const t1 = await m.ev("document.body.dataset.theme");
        await m.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }); await sleep(300);
        const t2 = await m.ev("document.body.dataset.theme");
        check('系统切深色 → 页面变深；切回浅色 → 变浅', t1 === 'dark' && t2 === 'light', [t1, t2]);
        await m.ev("document.getElementById('btn-theme').click()"); await sleep(200);
        await m.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }); await sleep(300);
        check('手动选了深色后，系统是浅色也保持深色', (await m.ev("document.body.dataset.theme")) === 'dark');
        await m.send('Emulation.setEmulatedMedia', { features: [] });
    });

    await caseRun('横向溢出：320 / 390 / 430 / 768 各界面', async () => {
        const sample = "document.getElementById('btn-home-sample').click()";
        for (const w of [320, 390, 430, 768]) {
            const c = await open(w, 800, 2);
            try {
                await reset(c, '');
                const probe = `(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, vr: document.getElementById('view-read').scrollWidth - document.getElementById('view-read').clientWidth }))()`;
                const home = await c.ev(probe);
                await c.ev(sample); await sleep(2500);
                const read = await c.ev(probe);
                await c.ev("switchState('edit')"); await sleep(1500);
                const edit = await c.ev(probe);
                await c.ev("document.getElementById('btn-hamburger').click()"); await sleep(400);
                const drawer = await c.ev(probe);
                const bad = [home, read, edit, drawer].filter(p => p.sw > w || p.iw > w || p.vr > 0);
                check(`${w} 宽：首页 / 阅读 / 编辑 / 侧边栏都没有横向溢出`, bad.length === 0, bad);
            } finally { c.close(); }
        }
    });

    m.close();

    // ---------------- 电脑 1280 ----------------
    const d = await open(1280, 900, 1);
    await d.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await d.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

    await caseRun('P2-6 / O-5 大文档打字不再每个字整篇渲染', async () => {
        const lines = ['# 大文档'];
        for (let i = 0; i < 390; i++) lines.push(`## 节 ${i}`, `- 列表项 ${i} 含公式 $x_${i}^2$`, `| a | b |`, `|---|---|`, `| ${i} | ${i * 2} |`);
        const big = lines.join('\n');
        await reset(d, dbJs([{ id: 'a', title: '大', content: big }]));
        await openFromDrawer(d, '大'); await sleep(1500);
        await d.ev("switchState('edit')"); await sleep(2500);
        await d.ev("window.__renders = 0; const _r = window.renderMarkdown; window.renderMarkdown = function (t, target) { if (target === editorPreview) window.__renders++; return _r.apply(this, arguments); }; editorTextarea.focus(); editorTextarea.setSelectionRange(editorTextarea.value.length, editorTextarea.value.length); true");
        const cost = await d.ev('lastRenderCost');
        await d.send('Input.insertText', { text: '\n\n' }); await sleep(40);
        for (const ch of 'abcdefgh') { await d.send('Input.insertText', { text: ch }); await sleep(40); }
        await sleep(800);
        const n = await d.ev('window.__renders');
        check(`连续敲 8 个字只渲染 ≤ 2 次（单次渲染 ${Math.round(cost)}ms）`, cost >= 30 ? n <= 2 : true, { renders: n, cost: Math.round(cost) });
        check('停下后预览是最新内容', (await d.ev("document.getElementById('editor-preview').innerText")).includes('abcdefgh'));
        // 复审4-4：敲完字立刻保存（150ms 防抖还没到），离开编辑页后不该再在看不见的预览上整篇渲染一次
        await d.send('Input.insertText', { text: 'Z' });
        await d.ev('window.__renders = 0; saveEdit(); true'); await sleep(900);
        check('敲完字马上保存：离开编辑页后预览不再渲染', (await d.ev('window.__renders')) === 0 && (await d.ev('currentState')) === 'read', await d.ev('window.__renders'));
    });

    await caseRun('O-9 电脑：目录高亮当前节、可收起、没标题自动收起', async () => {
        const long = Array.from({ length: 30 }, (_, i) => `## 第${i}节\n\n` + Array.from({ length: 8 }, () => '内容'.repeat(40)).join('\n\n')).join('\n\n');
        await reset(d, dbJs([{ id: 'a', title: '长', content: '# 长\n\n' + long }, { id: 'b', title: '无标题', content: '没有标题的文字' }]));
        await openFromDrawer(d, '长'); await sleep(900);
        await d.ev("const t = [...document.querySelectorAll('#reader-content h2')][10]; const v = document.getElementById('view-read'); v.scrollTop += t.getBoundingClientRect().top - v.getBoundingClientRect().top - 5"); await sleep(300);
        const act = await d.ev("(document.querySelector('#toc-content .toc-link.active') || {}).textContent");
        check('滚到第 10 节：目录高亮「第10节」', act === '第10节', act);
        await d.ev("document.getElementById('btn-toc-toggle').click()"); await sleep(400);
        const w1 = await d.ev("document.getElementById('toc-sidebar').getBoundingClientRect().width");
        check('点目录按钮可以收起', w1 < 2, w1);
        const bgOff = await d.ev("getComputedStyle(document.getElementById('btn-toc-toggle')).backgroundColor");
        await d.ev("document.getElementById('btn-toc-toggle').click()"); await sleep(300);
        const bgOn = await d.ev("getComputedStyle(document.getElementById('btn-toc-toggle')).backgroundColor");
        check('目录开关：展开时按钮有底色、收起时没有（看得出状态）', bgOn !== bgOff && !/rgba\(0, 0, 0, 0\)|transparent/.test(bgOn), { bgOff, bgOn });
        await d.ev("document.getElementById('btn-toc-toggle').click()"); await sleep(300);
        await d.ev("document.getElementById('btn-toc-toggle').click()"); await sleep(400);
        await openFromDrawer(d, '无标题'); await sleep(700);
        const w2 = await d.ev("({ w: document.getElementById('toc-sidebar').getBoundingClientRect().width, btn: document.getElementById('btn-toc-toggle').classList.contains('hidden') })");
        check('没有标题的文档：目录栏自动收起', w2.w < 2 && w2.btn, w2);
    });

    await caseRun('O-4 快捷键：Ctrl+S 保存、Esc 关侧边栏、Tab 缩进', async () => {
        await reset(d, dbJs([{ id: 'a', title: '甲', content: '# 甲\n- 项' }]));
        await openFromDrawer(d, '甲'); await sleep(500);
        await d.ev("switchState('edit')"); await sleep(500);
        await d.ev("editorTextarea.focus(); editorTextarea.setSelectionRange(editorTextarea.value.length, editorTextarea.value.length)");
        await d.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
        await d.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await d.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        await d.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        await d.send('Input.insertText', { text: '- 子项' });
        const v = await d.ev('editorTextarea.value');
        check('Tab 在编辑框里插入缩进（焦点没跑掉）', v.endsWith('\n    - 子项') && (await d.ev('document.activeElement === editorTextarea')), J(v));
        await d.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: 2 });
        await d.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: 2 });
        await sleep(700);
        check('Ctrl+S 保存并回到阅读页', (await state(d)) === 'read' && (await getDB(d)).files[0].content.includes('    - 子项'));
        await d.ev("document.getElementById('btn-hamburger').click()"); await sleep(400);
        await d.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await sleep(400);
        check('Esc 关掉侧边栏', !(await d.ev('drawerOpen')));
    });

    await caseRun('光标同步预览（回归）：点哪一行，预览定位到对应列表项', async () => {
        const list = '# 题目\n\n' + Array.from({ length: 100 }, (_, i) => `${i + 1}. 第${i + 1}题 ` + '内容'.repeat(10)).join('\n');
        await reset(d, dbJs([{ id: 'a', title: '题', content: list }]));
        await openFromDrawer(d, '题'); await sleep(500);
        await d.ev("switchState('edit')"); await sleep(1000);
        await d.ev("const v = editorTextarea.value; const i = v.indexOf('第30题'); editorTextarea.focus(); editorTextarea.setSelectionRange(i, i); editorTextarea.dispatchEvent(new Event('click'))");
        await sleep(300);
        const r = await d.ev("(() => { const p = document.querySelector('.preview-pane').getBoundingClientRect(); const li = [...document.querySelectorAll('#editor-preview li')].find(l => l.textContent.startsWith('第30题')); return { rel: Math.round(li.getBoundingClientRect().top - p.top), hl: li.classList.contains('sync-highlight') }; })()");
        check('第 30 题顶到预览上方并闪一下', r.rel >= 0 && r.rel < 40 && r.hl, r);
    });

    d.close();
    srv.close();
    const failed = results.filter(r => !r.ok);
    console.log(`\n共 ${results.length} 条，通过 ${results.length - failed.length}，失败 ${failed.length}`);
    failed.forEach(f => console.log('  ✗ ' + f.name));
    process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
