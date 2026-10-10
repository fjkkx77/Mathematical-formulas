# 数学公式阅读器（Mathematical-formulas）现状与交接

> 给下一次接手的人（包括换了会话的 Claude）。改这个仓库之前先读这份；改完如果改变了下面写的任何一条，回来更新。
> 最后更新：2026-10-10（左边缘触发区收窄、手机编辑加回「分屏」，跟 markdown-reader 同时改）

## 一、基本事实
- 线上：https://fjkkx77.github.io/Mathematical-formulas/ ，GitHub Pages 发 **`master` 分支**（不是 main），push 就是上线。
- 整个应用就是一个 `index.html`（工作区 CRLF，仓库里存 LF，脚本改它时注意）。第三方库全从 CDN 加载、全部钉死版本。
- 它是 markdown-reader 的姊妹站：结构同源，但**公式走 MathJax（按需加载）**，有自己的 `$` 扩展、金额防护、四种定界符；没有代码行号。
- 测试：`MDR_PROXY=http://127.0.0.1:8800 node tests/verify.cjs`（真实 headless Chrome，手机 390 + 电脑 1280，150 条）。
  测旧版本（A/B）时加 `MDR_LEGACY=1`（旧版没有新变量，严格的就绪判断等不到）。
  `node tests/verify.cjs <目录>` 测别的目录里的 index.html（拿旧版做 A/B）；`ONLY=正则` 只跑名字匹配的用例。
  测试是从 markdown-reader 那边移植的，去掉了 KaTeX / 代码行号，加了本站特有的公式用例。

## 二、改之前必须知道的约束
1. **公式**：`$`、`$$` 不是 MathJax 认的，是 `mathExtension` / `mathBlockExtension` 转成 `\(...\)` `\[...\]` 的；
   `docHasMath()` 决定加不加载 MathJax，加新定界符漏改它会静默不渲染；金额防护（`looksLikeProse` + 「闭合 $ 后紧跟数字」）
   是用户踩坑换来的，不许简单删。详见记忆库 `project_math_formulas_site.md`。
2. **XSS 防线**：产出 HTML 的永远是完整的 `marked.parse()`，`postprocess` 里的 `DOMPurify.sanitize`（`ADD_ATTR:['style']`、
   `FORBID_TAGS:['style','form']`）只在这条路径上生效；绝不能改成逐块 `marked.parser`。拼进 innerHTML 的文件名一律 `escapeHtml`。
3. **改文档库一律走 `mutateDB(fn)`**（在最新的库上改一处再存），换文档一律走 `openDoc` / `confirmLeaveEdit`，
   页面里不用原生 alert/confirm/prompt（测试会扫源码）。这三条跟 markdown-reader 完全一样，那边 PROJECT_STATUS 第二节有细节。
4. **跟 markdown-reader 共用存储**：`md-pro-db`（文档库）、`md-theme`、`md-font-scale`、`md-pro-sort` 是同一份；
   2026-10-09 新加的键里，草稿 `mdr-draft:<id>`、`mdr-theme-choice`、`mdr-theme-migrated`、`mdr-toc-hidden`、`mdr-last-export` 两站共用；
   **「读到哪」`mf-read-pos`、「上次看的哪篇」`mf-last-doc` 本站单独记**（公式排版不同，同一篇两站高度不一样）。
   示例文档 id 是 `sample-math`（markdown-reader 的是 `sample`，原来两站点「示例」会互相覆盖）。
5. **每次打开都是首页**，「接着上次读」只做成按钮（首页「继续阅读」+ 底部「回到上次读到的位置」），不许改成自动跳（用户 2026-10-09 定）。
6. **不做双指缩放**（用户 2026-10-09 定），viewport 的 `user-scalable=no` 保留。
7. **侧边栏开关手势要先锁方向**（2026-10-10 修，跟 markdown-reader 同一段代码、两站一起改）：横向 > 纵向×1.5 才算横滑，
   否则当滚动。旧版只看横向位移，在抽屉右半边上下滑文件列表会被误关。细节见 markdown-reader PROJECT_STATUS 第二节第 9 条。
8. **左边缘右滑开侧边栏的起点范围是 24px**（`DRAWER_EDGE_PX`，2026-10-10 从 40 收窄：用户反馈太宽、左右滑动时经常误开），
   起点落在能横向滚动的内容里（宽表格、代码块、长公式，`inHScroller`）也不开。24 是我定的、没有官方出处；用户嫌难触发再调，别悄悄改回 40。
   测试「左边缘右滑的起点范围」。
9. **手机编辑页有三种看法：编辑（整屏）/ 分屏（上下各半）/ 预览（整屏）**（2026-10-10，用户要求整屏和上下半屏并存、自己切）。
   点哪个记在 `mdr-edit-tab`（两站共用），上次是分屏下次进编辑还是分屏；别删掉其中任何一种。
   刚进编辑页、还没点过编辑框时预览不跟光标（`cursorPlaced`）：填内容后光标默认在末尾，跟着滚会变成「编辑框在开头、预览在文末」。

## 三、2026-10-09 同步了什么
跟 markdown-reader 那批整改一一对应（那边 PROJECT_STATUS 第三节有完整列表），在本站的落点：
- 安全：mermaid 10.9.3→10.9.8、dompurify→3.4.16、
  （注意：CVE-2025-54881 那个 PoC 在 markdown-reader 旧版上会执行，**在本站旧版上实测没触发**（执行 0 次）。原因没查实，推测是
  Mermaid 这条代码路径要用到页面上的 KaTeX、本站没有——不确定。升级照样要做：10.9.3 另外几条公开漏洞（样式注入、卡死）跟 KaTeX 无关。）
  MathJax 从 `@3` 钉死到 `3.2.2`（当时 @3 实际给的就是它，无公开漏洞）；
  禁 `<style>`/`<form>`；正文容器 `contain: layout`。
- 数据：未保存先问、`mutateDB` + storage 监听 + 保存前检测冲突、备份与恢复 / 单篇下载、草稿、数据损坏处理、导入检查类型与 GBK、同名导入先问。
- 体验：继续阅读 / 回到上次位置（按钮）、搜索、手机编辑/预览标签、目录高亮与收起、页面内弹框、快捷键、打字停顿再渲染（本站把 MathJax 排版时间算进去、
  把第一次下载 MathJax 的网络时间扣掉）、Mermaid 出错不影响目录、外链新标签、44px 触摸区域、顶栏布局改成按内容宽度排（原来 1:2:1，按钮一多右侧会挤）等。
- 本站原来有、这次保留的：四种定界符、金额防护、MathJax 按需加载、字号读出来夹在 0.8~1.4。
- 本站没有、没加的：代码行号（要求代码字号随阅读字号缩放，跟行号对齐冲突）。

### 同步后又跑了一轮 /code-review
10 处，都修了（多数是两站共用代码，markdown-reader 同步修）：数据损坏下载后要确认存好、「回到上次位置」用显示时的位置、共用草稿只自动删本页写的、
离开编辑页不再渲染预览、弹框里 Ctrl+S、弹框淡出不挡点击、null 条目、存一次少解析几遍库、目录开关的打开底色（本站原来缺这条样式）、
**MathJax 排版排队一次只跑一个**（本站特有，见 mathTypesetQueue）。

## 四、还没确认的事
- iPhone 真机的那几项跟 markdown-reader 一样（左边缘右滑、横屏刘海、键盘、外链返回、备份下载/恢复、长按拖文件夹），见那边 PROJECT_STATUS 第四节（含 2026-10-10 新加的：触发区 24px 的手感、分屏时键盘弹出后的大小、编辑页按钮位置等用户选方案）。
- 以前留在库里的旧示例（id `sample`、三道概率题）没删，它现在就是一篇普通文档；在 markdown-reader 里点「示例」会打开它（那边只在它是那边的旧默认内容时才升级）。
