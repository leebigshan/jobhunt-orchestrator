// Boss 求职辅助 · 页面右侧常驻侧边栏（Content Script）
//
// 交互：点击工具栏图标 → 当前页面右侧滑出侧边栏，常驻不消失
//      （不再使用 popup：切 tab / 点页面都不会自动收起；翻页后自动恢复）。
// 结构：
//   1) extractJob：读取当前职位详情页 DOM（多选择器兜底，容忍结构变化）
//   2) 侧边栏 UI：Shadow DOM 注入，样式/脚本与页面完全隔离
//   3) 后端请求统一经 background 代理（/ext/*），绕开页面 CORS
// 原则：不抓取、不跳转、不自动操作页面，仅在用户点击后就地分析。

(function () {
  "use strict";
  if (window.__BOSS_ASSIST_LOADED__) return; // 防重复注入
  window.__BOSS_ASSIST_LOADED__ = true;

  // ============================== 基础设施 ==============================

  const DEFAULT_BASE = "http://127.0.0.1:8000";
  const STORE_HISTORY = "bossassist_history";
  const STORE_RESUME = "bossassist_resume_md";        // 上传的 Markdown 简历正文
  const STORE_RESUME_NAME = "bossassist_resume_name"; // 简历文件名（展示用）
  const MAX_HISTORY = 50;
  const MAX_RESUME_CHARS = 200000; // 简历文本上限（约 200KB，远超正常简历）

  function storageGet(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (v) => resolve(v || {}));
      } catch (_) {
        resolve({});
      }
    });
  }
  function storageSet(obj) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(obj, () => resolve());
      } catch (_) {
        resolve();
      }
    });
  }

  // 后端请求 → background 代理转发
  function apiCall(path, method, body) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "API", path, method, body }, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(resp || { ok: false, error: "后台无响应" });
          }
        });
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  async function callBackend(path, body) {
    const resp = await apiCall(path, body ? "POST" : "GET", body);
    if (!resp.ok) throw new Error(resp.error || ("后端 " + path + " 返回 " + resp.status));
    return resp.data;
  }

  // ============================== 职位读取 ==============================

  function textOf(el) {
    if (!el) return "";
    return (el.innerText || "").replace(/\s+/g, " ").trim();
  }

  function firstText(selectors) {
    for (const s of selectors) {
      const el = document.querySelector(s);
      const t = textOf(el);
      if (t) return t;
    }
    return "";
  }

  // 详情页可能的选择器组合（Boss 桌面端），容忍页面结构变化
  // ====================== 提取层：反爬乱码处理 ======================
  // Boss 直聘等站点用自定义字体反爬：DOM 里能拿到的是私有区（PUA）映射字符，直接渲染出来是乱码。
  // 策略：检测乱码 → 优先从页面内嵌 JSON（__INITIAL_STATE__ 等）取真值 → 仍乱则提示用户手改（表单可编辑）。
  // [pure-helpers-start]
  const PUA_RE = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}]/u; // 必须带 u 标志，否则 \u{F0000} 级别的码点会解析错位
  function isGarbled(t) {
    return !!t && PUA_RE.test(t);
  }

  // 标题尾部常粘上薪资（如「Python AI开发 25-45K·14薪」），切掉薪资尾巴
  function cleanTitle(t) {
    if (!t) return t;
    const cut = t.replace(/\s+[\d\uE000-\uF8FF][\d\uE000-\uF8FF\-–~～KkWw万·.]*薪[\s\S]*$/, "").trim();
    return cut || t.trim();
  }

  // 从一段脚本文本中解析 JSON 对象（整体 parse 失败则按花括号配对截取）
  function parseStateFromText(t) {
    try { return JSON.parse(t); } catch (_) { /* 继续 */ }
    let start = t.indexOf("__INITIAL_STATE__");
    start = start >= 0 ? t.indexOf("{", start) : t.indexOf("{");
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(t.slice(start, i + 1)); } catch (_) { return null; }
        }
      }
    }
    return null;
  }

  // 递归扫 JSON，按 key 名收集 title/salary/company 真值
  function walkJson(node, depth, out) {
    if (!node || depth > 6 || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const v of node.slice(0, 50)) walkJson(v, depth + 1, out);
      return;
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === "string") {
        const lk = k.toLowerCase();
        if (!out.title && /positionname|jobname/.test(lk) && v.length <= 60) out.title = v;
        else if (!out.salary && /salary/.test(lk) && /\d/.test(v) && v.length <= 30) out.salary = v;
        else if (!out.company && /companyname|brandname/.test(lk) && v.length <= 40) out.company = v;
      } else {
        walkJson(v, depth + 1, out);
      }
    }
  }
  // [pure-helpers-end]

  // 从页面内嵌 <script> 里兜底解析职位真值
  function jobFromInlineJson() {
    try {
      const scripts = document.querySelectorAll("script");
      for (const s of scripts) {
        const t = s.textContent || "";
        if (t.length < 50 || t.length > 2000000) continue;
        if (t.indexOf("positionName") < 0 && t.indexOf("salaryDesc") < 0 && t.indexOf('"salary"') < 0) continue;
        const found = {};
        walkJson(parseStateFromText(t), 0, found);
        if (Object.keys(found).length) return found;
      }
    } catch (_) { /* 忽略 */ }
    return {};
  }

  function extractJob() {
    const title = firstText([
      ".job-detail .name",
      ".job-banner .name",
      ".job-title",
      "h1.name",
      '[class*="job-name"]',
    ]);
    const salary = firstText([
      ".job-detail .salary",
      ".job-banner .salary",
      '[class*="salary"]',
    ]);
    const company = firstText([
      ".job-detail .company-name",
      ".company-info .name",
      '[class*="company-name"]',
      '[class*="company"] .name',
    ]);
    const loc = firstText([
      ".job-detail .location-address",
      ".job-location",
      '[class*="location"]',
    ]);
    const jd = firstText([
      ".job-sec-text",
      ".job-detail .text",
      '[class*="job-sec"]',
      '[class*="job-detail"] .article',
    ]);
    const tagEls = document.querySelectorAll('[class*="job-tags"] *');
    const tags = [];
    tagEls.forEach((el) => {
      const t = textOf(el);
      if (t && t.length <= 12 && !tags.includes(t)) tags.push(t);
    });

    const json = jobFromInlineJson();
    // 乱码/缺失时用内嵌 JSON 真值兜底；标题切掉粘连的薪资尾巴
    let title2 = (!title || isGarbled(title)) ? (json.title || title || "") : title;
    title2 = cleanTitle(title2);
    let salary2 = (!salary || isGarbled(salary) || !/\d/.test(salary)) ? (json.salary || salary || "") : salary;
    let company2 = (!company || isGarbled(company)) ? (json.company || company || "") : company;
    const garbled = isGarbled(title2) || isGarbled(salary2) || isGarbled(company2);

    return {
      url: window.location.href,
      title: title2,
      salary: salary2,
      company: company2,
      location: loc,
      jd_text: jd,
      job_tags: tags.slice(0, 20),
      garbled,
    };
  }

  function readJob() {
    const isBoss = /zhipin\.com/.test(window.location.href);
    return { job: extractJob(), isBoss };
  }

  // ============================== 侧边栏样式 ==============================

  const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
.panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 13px;
  color: #1f2328;
  background: #fff;
  box-shadow: -4px 0 18px rgba(0, 0, 0, .22);
  animation: boss-assist-slide .18s ease-out;
}
@keyframes boss-assist-slide {
  from { transform: translateX(28px); opacity: .3; }
  to   { transform: none; opacity: 1; }
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: linear-gradient(135deg, #00c2ff, #2d7bff);
  color: #fff;
  font-weight: 600;
}
.header-actions { display: flex; gap: 4px; }
header .ghost {
  background: rgba(255,255,255,.2);
  border: none;
  color: #fff;
  border-radius: 6px;
  width: 24px; height: 24px;
  cursor: pointer;
  font-size: 14px;
}
header .ghost:hover { background: rgba(255,255,255,.35); }

.panel-body { flex: 1; overflow: auto; }

.card { padding: 10px 12px; border-bottom: 1px solid #f0f0f0; }
.card.hidden, .hidden { display: none; }

.job-line { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.job-title { font-size: 14px; }
.salary { color: #ee4d2d; font-weight: 600; }
.job-meta { color: #888; margin-top: 4px; display: flex; gap: 8px; }
.job-meta span::before { content: "\u00b7"; margin-right: 2px; }

summary { cursor: pointer; color: #2d7bff; margin-top: 6px; }
.jd {
  white-space: pre-wrap; word-break: break-word;
  max-height: 120px; overflow: auto;
  background: #f7f9fc; padding: 8px; border-radius: 6px;
  margin-top: 6px; color: #444; font-size: 12px;
}

#controls { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; background: #fafbfc; }
#controls .primary {
  border: none; border-radius: 8px; padding: 10px;
  background: linear-gradient(135deg, #00c2ff, #2d7bff);
  color: #fff; font-size: 13px; font-weight: 500; cursor: pointer;
}
#controls .primary:hover { opacity: .9; }
#controls .primary:disabled { opacity: .5; cursor: not-allowed; }
#controls .primary.accent { background: linear-gradient(135deg, #ff8a00, #ff5e3a); }

.result-toolbar { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.result-label { font-size: 12px; color: #666; font-weight: 600; flex: 1; }
.ghost.small, button.small {
  border: 1px solid #d0d7de; background: #fafafa; color: #57606a;
  border-radius: 6px; cursor: pointer; font-size: 12px; padding: 2px 8px;
}
.ghost.small:hover, button.small:hover { background: #f0f0f0; }

.history-list { max-height: 220px; overflow: auto; }
.history-item {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 8px; border-bottom: 1px solid #f0f0f0; cursor: pointer;
}
.history-item:hover { background: #f7f9fc; }
.history-item .h-title { flex: 1; font-size: 12px; color: #1f2328; }
.history-item .h-meta { color: #888; font-size: 11px; }

.loading { color: #2d7bff; padding: 6px 0; animation: boss-assist-pulse 1.2s infinite; }
@keyframes boss-assist-pulse { 50% { opacity: .4; } }

/* ---- 结果区（Markdown 富文本渲染） ---- */
.result-body {
  background: #f7f9fc; padding: 10px 12px; border-radius: 8px;
  max-height: 46vh; overflow: auto;
  font-size: 12.5px; line-height: 1.7; word-break: break-word;
}
.result-body h2 { font-size: 15px; margin: 2px 0 8px; color: #0b3d91; }
.result-body h3 {
  font-size: 13px; margin: 12px 0 6px; color: #2d7bff;
  border-left: 3px solid #2d7bff; padding-left: 6px;
}
.result-body h4 { font-size: 12.5px; margin: 8px 0 4px; color: #1f2328; }
.result-body p { margin: 6px 0; }
.result-body ul, .result-body ol { margin: 6px 0 6px 18px; }
.result-body li { margin: 3px 0; }
.result-body code {
  background: #eef2f7; padding: 1px 5px; border-radius: 4px; font-size: 11.5px;
}
.result-body pre {
  background: #1f2328; color: #e6edf3; padding: 8px 10px;
  border-radius: 6px; overflow: auto; margin: 8px 0;
}
.result-body pre code { background: none; color: inherit; padding: 0; }
.result-body blockquote {
  border-left: 3px solid #ffd666; background: #fffbe6; color: #8a6d1a;
  padding: 6px 10px; border-radius: 0 6px 6px 0; margin: 8px 0;
}
.result-body table { border-collapse: collapse; margin: 8px 0; width: 100%; font-size: 12px; }
.result-body th, .result-body td { border: 1px solid #d0d7de; padding: 4px 8px; text-align: left; }
.result-body th { background: #eef2f7; }
.result-body hr { border: none; border-top: 1px dashed #d0d7de; margin: 10px 0; }
.result-body a { color: #2d7bff; text-decoration: none; }

/* ---- 职位确认表单（提取 → 核对/修改 → 确认） ---- */
.job-form { margin-top: 6px; }
.job-form label { display: block; font-size: 11px; color: #888; margin: 6px 0 2px; }
.f-input, .f-text {
  width: 100%; border: 1px solid #d0d7de; border-radius: 6px;
  padding: 5px 8px; font-size: 12px; color: #1f2328; background: #fff;
  font-family: inherit;
}
.f-input:focus, .f-text:focus { outline: none; border-color: #2d7bff; background: #f7fbff; }
.f-row { display: flex; gap: 8px; }
.f-col { flex: 1; min-width: 0; }
.f-text { resize: vertical; min-height: 90px; line-height: 1.5; }
.job-hint {
  font-size: 11px; color: #b26a00; background: #fff7e6;
  border-radius: 6px; padding: 5px 8px; margin-top: 8px; line-height: 1.5;
}
.job-hint.ok { color: #1a7f37; background: #eaf7ee; }
.confirm-btn {
  border: none; border-radius: 6px; padding: 4px 10px; cursor: pointer;
  font-size: 12px; font-weight: 600; color: #fff;
  background: linear-gradient(135deg, #1a7f37, #34c759);
}
.confirm-btn:hover { opacity: .9; }
.confirm-btn.on { background: linear-gradient(135deg, #8a8f98, #b0b5bd); }

/* ---- 折叠（点标题收起/展开，不遮挡结果） ---- */
.result-label { cursor: pointer; user-select: none; }
.result-label::before { content: "▾"; margin-right: 4px; font-size: 10px; color: #999; }
.card.folded .result-label::before { content: "▸"; }
.card.folded > *:not(.result-toolbar) { display: none !important; }
.card.folded { padding-bottom: 8px; }

/* ---- 模块管理（裁剪不需要的功能/卡片） ---- */
.mod-panel {
  margin-bottom: 6px; padding: 8px; border: 1px dashed #d0d7de;
  border-radius: 6px; font-size: 11.5px; max-height: 220px; overflow: auto;
}
.mod-panel .mod-group { font-weight: 600; color: #888; margin: 4px 0 2px; }
.mod-panel label { display: flex; align-items: center; gap: 5px; padding: 2px 0; color: #444; cursor: pointer; }
.mod-panel input { accent-color: #2d7bff; }
.mod-off { display: none !important; }

/* ---- 简历卡片 ---- */
.resume-status { font-size: 11.5px; color: #888; margin-top: 6px; line-height: 1.5; }
.resume-status.on { color: #34c759; }

.backend-status {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 12px; font-size: 12px; color: #666;
  border-top: 1px solid #f0f0f0;
}
.dot { width: 8px; height: 8px; border-radius: 50%; background: #ccc; display: inline-block; }
.dot.on { background: #34c759; }
.dot.off { background: #ff3b30; }

.hint { padding: 6px 12px; color: #aaa; font-size: 11px; }
`;

  const HTML = `
<div class="panel">
  <header>
    <div class="brand">Boss 求职辅助</div>
    <div class="header-actions">
      <button id="btn-settings" class="ghost" title="设置后端地址">&#9881;</button>
      <button id="btn-history" class="ghost" title="查看分析历史">&#128339;</button>
      <button id="btn-refresh" class="ghost" title="重新读取当前页">&#8635;</button>
      <button id="btn-close" class="ghost" title="收起侧边栏">&#10005;</button>
    </div>
  </header>

  <div class="panel-body">
    <!-- 当前职位：提取 → 核对/修改 → 确认后才分析 -->
    <section id="job-card" class="card hidden">
      <div class="result-toolbar">
        <span class="result-label">① 职位信息（自动提取 · 可修改 · 点标题折叠）</span>
        <button id="btn-job-reload" class="ghost small">↻ 重新加载</button>
        <button id="btn-job-confirm" class="confirm-btn">✅ 确认，启用分析</button>
      </div>
      <div class="job-form">
        <label>职位名称</label>
        <input id="job-title" class="f-input" placeholder="职位名称">
        <div class="f-row">
          <div class="f-col"><label>公司</label><input id="job-company" class="f-input" placeholder="公司"></div>
          <div class="f-col"><label>薪资</label><input id="job-salary" class="f-input" placeholder="如 20-30K"></div>
        </div>
        <div class="f-row">
          <div class="f-col"><label>地点</label><input id="job-location" class="f-input" placeholder="城市/区域"></div>
          <div class="f-col"><label>标签</label><input id="job-tags" class="f-input" placeholder="逗号分隔"></div>
        </div>
        <label>职位描述（JD，分析基于这里的内容）</label>
        <textarea id="job-jd" class="f-text" rows="6" placeholder="职位描述正文"></textarea>
      </div>
      <div id="job-hint" class="job-hint">正在提取当前页职位信息…</div>
    </section>

    <!-- 我的简历（Markdown，可选） -->
    <section id="resume-card" class="card">
      <div class="result-toolbar">
        <span class="result-label">📄 我的简历（Markdown · 点标题折叠）</span>
        <button id="btn-resume-pick" class="ghost small">加载 .md</button>
        <button id="btn-resume-view" class="ghost small">查看</button>
        <button id="btn-resume-clear" class="ghost small">清除</button>
      </div>
      <input id="resume-file" type="file"
             accept=".md,.markdown,.txt,text/markdown,text/plain" class="hidden">
      <div id="resume-status" class="resume-status">未加载 — 加载后「评估 / 一键分析 / 简历优化」会参考你的简历</div>
      <pre id="resume-preview" class="jd hidden"></pre>
    </section>

    <!-- 主功能按钮（确认职位信息后启用；⚙ 模块管理可裁剪不需要的功能） -->
    <section id="controls" class="card hidden">
      <div class="result-toolbar">
        <span class="result-label">⚡ 功能（点标题折叠 · ⚙ 模块管理可关功能）</span>
        <button id="btn-mods" class="ghost small">⚙ 模块管理</button>
      </div>
      <div id="mod-panel" class="mod-panel hidden"></div>
      <button id="btn-pack" class="primary accent">&#9889; 一键分析</button>
      <button id="btn-assess" class="primary">&#128269; 评估职位</button>
      <button id="btn-analysis" class="primary">&#128202; 深度分析</button>
      <button id="btn-plan" class="primary">&#128218; 准备计划</button>
      <button id="btn-company" class="primary">&#127970; 公司情报</button>
      <button id="btn-salary" class="primary">&#128176; 谈薪策略</button>
      <button id="btn-intro" class="primary">&#127908; 自我介绍</button>
      <button id="btn-star" class="primary">&#11088; 项目讲稿</button>
      <button id="btn-summary" class="primary">&#128203; 岗位速览</button>
      <button id="btn-interview" class="primary">&#127919; 面试预测</button>
      <button id="btn-optimize" class="primary">&#128196; 简历优化</button>
      <button id="btn-greeting" class="primary">&#128172; 打招呼语</button>
      <button id="btn-chat" class="primary">&#129504; HR 话术</button>
    </section>

    <!-- 结果区（含一键复制） -->
    <section id="result" class="card hidden">
      <div class="result-toolbar">
        <span class="result-label">结果</span>
        <button id="btn-copy" class="ghost small">&#128203; 复制</button>
        <button id="btn-fav" class="ghost small" title="收藏到历史">&#11088; 收藏</button>
      </div>
      <div id="result-loading" class="loading hidden">分析中…</div>
      <div id="result-body" class="result-body">-</div>
    </section>

    <!-- 历史收藏 -->
    <section id="history" class="card hidden">
      <div class="result-toolbar">
        <span class="result-label">分析历史 / 收藏</span>
        <button id="btn-history-close" class="ghost small">关闭</button>
      </div>
      <div id="history-list" class="history-list"></div>
    </section>
  </div>

  <!-- 后端状态 -->
  <section id="backend-status" class="backend-status">
    <span id="backend-dot" class="dot"></span>
    <span id="backend-text">后端未连接</span>
  </section>

  <footer class="hint">
    提取职位 → 核对/修改 → ✅ 确认 → 分析（分析使用确认后的内容）。点卡片标题可折叠；「⚙ 模块管理」可关掉不需要的功能；「↻ 重新加载」重读当页。<span id="ver-tag" style="opacity:.6"></span>
  </footer>
</div>
`;

  // ============================== 面板挂载 ==============================

  let host = null;
  let els = null;
  let sh = null; // ShadowRoot 外层引用（closed shadow 必须显式保存，供折叠/模块/结果聚焦等外层函数使用）
  let panelVisible = false;
  let lastResult = "";
  let historyCache = null;

  function mountPanel() {
    // 旧挂载点可能被页面移除 → 重建
    if (host && host.isConnected) return;

    host = document.createElement("div");
    host.id = "boss-assist-host";
    host.style.cssText = [
      "position:fixed",
      "top:0",
      "right:0",
      "height:100vh",
      "width:380px",
      "max-width:92vw",
      "z-index:2147483647",
    ].join(";");

    const shadow = host.attachShadow({ mode: "closed" });
    sh = shadow;
    const style = document.createElement("style");
    style.textContent = CSS;
    shadow.appendChild(style);

    const wrap = document.createElement("div");
    wrap.innerHTML = HTML;
    shadow.appendChild(wrap);

    (document.documentElement || document.body).appendChild(host);

    const $ = (id) => sh.getElementById(id);
    els = {
      refresh: $("btn-refresh"),
      settings: $("btn-settings"),
      historyBtn: $("btn-history"),
      historyClose: $("btn-history-close"),
      closeBtn: $("btn-close"),
      jobCard: $("job-card"),
      jTitle: $("job-title"),
      jSalary: $("job-salary"),
      jCompany: $("job-company"),
      jLocation: $("job-location"),
      jTags: $("job-tags"),
      jJd: $("job-jd"),
      jobHint: $("job-hint"),
      jobConfirm: $("btn-job-confirm"),
      jobReload: $("btn-job-reload"),
      btnMods: $("btn-mods"),
      modPanel: $("mod-panel"),
      resumeFile: $("resume-file"),
      resumePick: $("btn-resume-pick"),
      resumeView: $("btn-resume-view"),
      resumeClear: $("btn-resume-clear"),
      resumeStatus: $("resume-status"),
      resumePreview: $("resume-preview"),
      controls: $("controls"),
      btnAssess: $("btn-assess"),
      btnPack: $("btn-pack"),
      btnAnalysis: $("btn-analysis"),
      btnPlan: $("btn-plan"),
      btnSummary: $("btn-summary"),
      btnInterview: $("btn-interview"),
      btnOptimize: $("btn-optimize"),
      btnGreeting: $("btn-greeting"),
      btnChat: $("btn-chat"),
      btnCompany: $("btn-company"),
      btnSalary: $("btn-salary"),
      btnIntro: $("btn-intro"),
      btnStar: $("btn-star"),
      result: $("result"),
      loading: $("result-loading"),
      resultBody: $("result-body"),
      copyBtn: $("btn-copy"),
      favBtn: $("btn-fav"),
      historyPanel: $("history"),
      historyList: $("history-list"),
      backendDot: $("backend-dot"),
      backendText: $("backend-text"),
    };

    wireEvents();
    checkBackend();
    initFoldModules();
    initRead();
    initResume();
    // 版本角标：一眼确认插件是否已更新（chrome.runtime.getManifest 只在新脚本里拿到新版本）
    try {
      const vt = sh.getElementById("ver-tag");
      const ver = (chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest().version) || "?";
      if (vt) vt.textContent = " · v" + ver;
    } catch (_) { /* 忽略 */ }
  }

  function togglePanel(force) {
    const show = typeof force === "boolean" ? force : !panelVisible;
    if (show) mountPanel();
    if (host) host.style.display = show ? "block" : "none";
    panelVisible = show;
    storageSet({ bossassist_panel_open: show });
  }

  // ============================== 渲染 ==============================

  let jobConfirmed = false; // 用户核对/修改职位信息并确认后才放行分析

  function renderJob(job) {
    els.jTitle.value = job.title || "";
    els.jSalary.value = job.salary || "";
    els.jCompany.value = job.company || "";
    els.jLocation.value = job.location || "";
    els.jTags.value = (job.job_tags || []).join(", ");
    els.jJd.value = job.jd_text || "";
    els.jobCard.classList.remove("hidden");
    // 提取 ≠ 分析依据：等用户核对/修改并确认后才显示功能按钮
    els.controls.classList.add("hidden");
    jobConfirmed = false;
    els.jobConfirm.textContent = "✅ 确认，启用分析";
    els.jobConfirm.classList.remove("on");
    setJobHint(
      job.garbled
        ? "⚠ 该站点用字体反爬，部分字段可能是乱码，已尽量自动还原。请重点核对职位名称/薪资，可直接修改后再确认。"
        : "已自动提取当前页职位信息 → 请核对，有误可直接修改 → 点「✅ 确认，启用分析」。"
    );
  }

  function setJobHint(msg, ok) {
    els.jobHint.textContent = msg;
    els.jobHint.classList.toggle("ok", !!ok);
  }

  function collectJob() {
    return {
      url: (typeof window !== "undefined" && window.location && window.location.href) || "",
      title: els.jTitle.value.trim(),
      salary: els.jSalary.value.trim(),
      company: els.jCompany.value.trim(),
      location: els.jLocation.value.trim(),
      jd_text: els.jJd.value.trim(),
      job_tags: els.jTags.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean).slice(0, 20),
    };
  }

  function confirmJob() {
    const job = collectJob();
    if (!job.title && !job.jd_text) {
      setJobHint("❌ 职位名称和职位描述不能都为空，请补充后再确认。");
      return;
    }
    jobConfirmed = true;
    els.jobConfirm.textContent = "✅ 已确认";
    els.jobConfirm.classList.add("on");
    setJobHint("✓ 已确认 · 分析将使用上方内容；修改后直接再点功能按钮即可生效。", true);
    els.controls.classList.remove("hidden");
    els.controls.scrollIntoView({ block: "nearest" });
  }

  // ============================== 折叠 & 模块管理 ==============================

  const FOLD_KEY = "bossassist_folded";   // 折叠状态（卡片 id 列表）
  const MOD_KEY = "bossassist_modules";   // 隐藏模块（卡片/功能按钮 id 列表）
  // 可裁剪模块：用户在「⚙ 模块管理」里关掉不需要的卡片/功能
  const MOD_GROUPS = [
    ["卡片", [
      ["job-card", "职位信息"], ["resume-card", "我的简历"], ["controls", "功能区"],
      ["result", "结果区（分析时会自动显示）"], ["history", "历史 / 收藏"],
    ]],
    ["功能按钮", [
      ["btn-pack", "一键分析"], ["btn-assess", "评估职位"], ["btn-analysis", "深度分析"],
      ["btn-plan", "准备计划"], ["btn-company", "公司情报"], ["btn-salary", "谈薪策略"],
      ["btn-intro", "自我介绍"], ["btn-star", "项目讲稿"], ["btn-summary", "岗位速览"],
      ["btn-interview", "面试预测"], ["btn-optimize", "简历优化"], ["btn-greeting", "打招呼语"],
      ["btn-chat", "HR 话术"],
    ]],
  ];
  const FOLD_CARDS = ["job-card", "resume-card", "controls", "result", "history"];
  let foldState = new Set();
  let hiddenSet = new Set();

  async function initFoldModules() {
    const sf = await storageGet([FOLD_KEY]);
    foldState = new Set(sf[FOLD_KEY] || []);
    for (const id of FOLD_CARDS) {
      const card = sh.getElementById(id);
      if (!card) continue;
      if (foldState.has(id)) card.classList.add("folded");
      const label = card.querySelector(".result-label");
      if (label) label.addEventListener("click", () => toggleFold(id, card));
    }
    const sm = await storageGet([MOD_KEY]);
    hiddenSet = new Set(sm[MOD_KEY] || []);
    renderModPanel();
    applyModules();
  }

  function toggleFold(id, card) {
    const folded = card.classList.toggle("folded");
    if (folded) foldState.add(id); else foldState.delete(id);
    storageSet({ [FOLD_KEY]: [...foldState] });
  }

  function renderModPanel() {
    const parts = [];
    for (const [group, items] of MOD_GROUPS) {
      parts.push(`<div class="mod-group">${group}</div>`);
      for (const [id, label] of items) {
        parts.push(`<label><input type="checkbox" data-mod="${id}" ${hiddenSet.has(id) ? "" : "checked"}> ${label}</label>`);
      }
    }
    els.modPanel.innerHTML = parts.join("");
    els.modPanel.querySelectorAll("input[data-mod]").forEach((input) => {
      input.addEventListener("change", () => {
        const id = input.getAttribute("data-mod");
        if (input.checked) hiddenSet.delete(id); else hiddenSet.add(id);
        storageSet({ [MOD_KEY]: [...hiddenSet] });
        applyModules();
      });
    });
  }

  function applyModules() {
    for (const [, items] of MOD_GROUPS) {
      for (const [id] of items) {
        const el = sh.getElementById(id);
        if (!el) continue;
        el.classList.toggle("mod-off", hiddenSet.has(id));
      }
    }
  }

  // 出结果场景：折叠上方「职位信息/我的简历/功能」三卡，展开结果卡并滚动到位——
  // 结果是主角，不被遮挡、不用手动找
  function focusResult() {
    for (const id of ["job-card", "resume-card", "controls"]) {
      const card = sh.getElementById(id);
      if (card && !card.classList.contains("folded")) {
        card.classList.add("folded");
        foldState.add(id);
      }
    }
    els.result.classList.remove("folded", "hidden", "mod-off");
    foldState.delete("result");
    storageSet({ [FOLD_KEY]: [...foldState] });
    try {
      els.result.scrollIntoView({ block: "start", behavior: "smooth" });
    } catch (_) {
      els.result.scrollIntoView({ block: "start" });
    }
  }

  function setBusy(on) {
    const btns = [els.btnAssess, els.btnPack, els.btnAnalysis, els.btnPlan,
                  els.btnCompany, els.btnSalary, els.btnIntro, els.btnStar,
                  els.btnSummary, els.btnInterview,
                  els.btnOptimize, els.btnGreeting, els.btnChat];
    btns.forEach((b) => (b.disabled = on));
    els.jobConfirm.disabled = on;
    els.loading.classList.toggle("hidden", !on);
    if (on) {
      els.result.classList.remove("hidden", "mod-off");
      els.resultBody.textContent = "…";
      focusResult();
    }
  }

  function showResult(text) {
    lastResult = text;
    els.loading.classList.add("hidden");
    els.result.classList.remove("hidden", "mod-off");
    focusResult();
    // Markdown 富文本渲染（BOSSMD 在 md.js 里，XSS 安全）；缺失时回退纯文本
    if (typeof BOSSMD !== "undefined" && BOSSMD.render) {
      els.resultBody.innerHTML = BOSSMD.render(text);
    } else {
      els.resultBody.textContent = text;
    }
    els.result.scrollIntoView({ block: "nearest" });
  }

  async function checkBackend() {
    const resp = await apiCall("/ext/ping", "GET");
    const info = resp.ok ? resp.data : null;
    const on = !!info;
    els.backendDot.className = "dot " + (on ? "on" : "off");
    els.backendText.textContent = on
      ? "后端已连接 · " + ((info && info.model) || "") + ((info && info.llm_configured) ? "" : " (未配 LLM)")
      : "后端未连接（请先运行 python launch.py）";
    return on;
  }

  async function initRead() {
    try {
      const { job, isBoss } = readJob();
      if (!isBoss) {
        renderJob({});
        els.controls.classList.add("hidden");
        setJobHint("当前不在 Boss 直聘职位页。也可手动填写职位信息后点「✅ 确认，启用分析」。");
        showResult("⚠️ 当前不在 Boss 直聘页面");
        return;
      }
      renderJob(job);
      els.result.classList.add("hidden");
      els.historyPanel.classList.add("hidden");
    } catch (e) {
      showResult("❌ " + e.message);
    }
  }

  // ============================== 我的简历（Markdown 上传） ==============================

  async function loadResumeState() {
    const s = await storageGet([STORE_RESUME, STORE_RESUME_NAME]);
    return { md: s[STORE_RESUME] || "", name: s[STORE_RESUME_NAME] || "" };
  }

  function renderResumeState(state) {
    if (state.md) {
      const kb = Math.max(1, Math.round(state.md.length / 1024));
      els.resumeStatus.textContent =
        `已加载 ${state.name || "resume.md"} · ${kb}KB — 评估/一键分析/简历优化会自动参考`;
      els.resumeStatus.classList.add("on");
    } else {
      els.resumeStatus.textContent = "未加载 — 加载后「评估 / 一键分析 / 简历优化」会参考你的简历";
      els.resumeStatus.classList.remove("on");
    }
    els.resumePreview.textContent = state.md || "";
  }

  async function initResume() {
    renderResumeState(await loadResumeState());
  }

  function pickResume() {
    els.resumeFile.click();
  }

  function onResumeFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // 允许重复选同一文件
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const md = String(reader.result || "").slice(0, MAX_RESUME_CHARS);
      await storageSet({ [STORE_RESUME]: md, [STORE_RESUME_NAME]: file.name });
      renderResumeState({ md, name: file.name });
    };
    reader.onerror = () => showResult("❌ 简历读取失败，请重试");
    reader.readAsText(file, "utf-8");
  }

  async function toggleResumeView() {
    const state = await loadResumeState();
    if (!state.md) {
      renderResumeState(state);
      return;
    }
    els.resumePreview.classList.toggle("hidden");
  }

  async function clearResume() {
    await storageSet({ [STORE_RESUME]: "", [STORE_RESUME_NAME]: "" });
    renderResumeState({ md: "", name: "" });
    els.resumePreview.classList.add("hidden");
  }

  // 后端请求体统一附带已上传简历（base_resume），评分/优化全走后端 LLM
  async function withResume(extra) {
    const body = Object.assign({}, extra);
    const s = await storageGet([STORE_RESUME]);
    if (s[STORE_RESUME]) body.base_resume = s[STORE_RESUME];
    return body;
  }

  // ============================== 各功能 ==============================

  async function postJob(path) {
    // 分析一律使用「用户确认后的表单内容」（可编辑），不用页面原始提取值
    const job = collectJob();
    if (!jobConfirmed) throw new Error("请先核对职位信息并点「✅ 确认，启用分析」");
    if (!job.title && !job.jd_text) throw new Error("职位信息为空，请填写后再分析");
    return await callBackend(path, await withResume(job));
  }

  // 评分进度条（10 格）
  function scoreBar(score) {
    const n = Math.max(0, Math.min(10, Math.round((score || 0) / 10)));
    return "▰".repeat(n) + "▱".repeat(10 - n);
  }

  async function doAssess() {
    setBusy(true);
    try {
      const data = await postJob("/ext/assess");
      const m = data.match, s = data.salary;
      showResult(
        "## ⚖️ 综合评估\n\n" +
        `**结论：${data.verdict}** · 评分 ${m.score}/100 ${scoreBar(m.score)}\n\n` +
        "### 🎯 匹配度\n" +
        `- **依据**：${m.reason || "-"}\n` +
        `- **命中技能**：${m.matched_skills.length ? m.matched_skills.join("、") : "-"}\n` +
        `- **评分引擎**：${m.engine || "local"}\n\n` +
        "### 💰 薪资合理性\n" +
        `- ${s.note}（质量分 ${s.quality_score}）\n` +
        `- ${s.quality_note}\n\n` +
        (data.analysis_md ? data.analysis_md + "\n\n" : "") +
        `> 来源：当前页面${m.engine === "llm" ? " · 后端 LLM 评分" : ""}`
      );
    } catch (e) { showResult("❌ " + e.message); }
    finally { setBusy(false); }
  }

  // 一键分析（pack）：评估 + 深度分析 + 速览 + 打招呼 + 面试预测
  async function doPack() {
    setBusy(true);
    try {
      const data = await postJob("/ext/pack");
      const m = data.match, s = data.salary;
      const list = (arr, fallback) => (arr && arr.length)
        ? arr.map((x, i) => `${i + 1}. ${x}`).join("\n") : fallback;
      showResult(
        "## ⚡ 一键分析结果\n\n" +
        `**结论：${data.verdict}** · 评分 ${m.score}/100 ${scoreBar(m.score)}` +
        (s.meets_expectation === false ? " · ⚠️ 薪资不达标" : "") + "\n\n" +
        "### 🎯 匹配度\n" +
        `- **依据**：${m.reason || "-"}\n` +
        `- **命中技能**：${m.matched_skills.length ? m.matched_skills.join("、") : "-"}\n` +
        `- **评分引擎**：${m.engine || "local"}\n\n` +
        "### 💰 薪资\n" +
        `- ${s.note || "-"}\n\n` +
        (data.analysis_md ? data.analysis_md + "\n\n" : "") +
        "### 📋 岗位速览\n" +
        (data.summary || "(未生成)") + "\n\n" +
        "### 💬 打招呼语\n" +
        list(data.greetings, "(未生成)") + "\n\n" +
        "### 🎯 面试预测\n" +
        list(data.interview, "(未生成)")
      );
    } catch (e) { showResult("❌ " + e.message); }
    finally { setBusy(false); }
  }

  // 深度分析（analysis）：岗位画像/匹配点/差距/风险/行动建议（后端固定 Markdown 小节）
  async function doAnalysis() {
    setBusy(true);
    try {
      const data = await postJob("/ext/analysis");
      showResult(data.analysis_md || "(未生成)");
    } catch (e) { showResult("❌ " + e.message); }
    finally { setBusy(false); }
  }

  // 面试准备计划（plan）：7 天清单/高频题/项目包装/反问建议
  async function doPlan() {
    setBusy(true);
    try {
      const data = await postJob("/ext/plan");
      showResult(data.plan_md || "(未生成)");
    } catch (e) { showResult("❌ " + e.message); }
    finally { setBusy(false); }
  }

  // 单结果类新功能通用处理器（后端固定 Markdown 小节契约）
  async function doSimple(path, field) {
    setBusy(true);
    try {
      const data = await postJob(path);
      showResult(data[field] || "(未生成)");
    } catch (e) { showResult("❌ " + e.message); }
    finally { setBusy(false); }
  }

  // 公司情报（company）：业务/岗位定位/风险红旗/面经重点
  async function doCompany() {
    await doSimple("/ext/company", "company_md");
  }

  // 谈薪策略（salary-talk）：区间判断/开价/压价应对/时机红线
  async function doSalary() {
    await doSimple("/ext/salary-talk", "salary_md");
  }

  // 自我介绍（self-intro）：30 秒/1 分钟/3 分钟三档
  async function doIntro() {
    await doSimple("/ext/self-intro", "intro_md");
  }

  // STAR 项目讲稿（star）：简历项目 S/T/A/R 包装 + 深挖防线
  async function doStar() {
    await doSimple("/ext/star", "star_md");
  }

  async function doSummary() {
    setBusy(true);
    try {
      const data = await postJob("/ext/summary");
      const bullets = (data.summary || "").split("\n").filter(Boolean)
        .map((l) => "- " + l).join("\n");
      showResult("## 📋 岗位速览\n\n" + (bullets || "(未生成)"));
    } catch (e) { showResult("❌ " + e.message); }
    finally { setBusy(false); }
  }

  async function doInterview() {
    setBusy(true);
    try {
      const data = await postJob("/ext/interview");
      const items = data.questions && data.questions.length
        ? data.questions.map((q, i) => `${i + 1}. ${q}`).join("\n")
        : "(无 JD 或未生成)";
      showResult("## 🎯 面试考察点预测\n\n" + items +
        (data.note ? `\n\n> ${data.note}` : ""));
    } catch (e) { showResult("❌ " + e.message); }
    finally { setBusy(false); }
  }

  async function doOptimize() {
    setBusy(true);
    try {
      const rs = await loadResumeState();
      const data = await postJob("/ext/optimize");
      const srcNote = rs.md ? "基于你上传的简历优化" : "未上传简历，已基于后端默认简历优化";
      const warn = data.warnings && data.warnings.length
        ? "\n\n> ⚠️ 事实字段核对：" + data.warnings.join("；")
        : "\n\n> ✅ 事实字段（学历/时间/数字）核对通过";
      showResult(`## 📄 针对性简历\n\n> ${srcNote}\n\n` + data.optimized_md + warn);
    } catch (e) { showResult("❌ " + e.message); }
    finally { setBusy(false); }
  }

  async function doGreeting() {
    setBusy(true);
    try {
      const data = await postJob("/ext/greeting");
      const items = data.greetings && data.greetings.length
        ? data.greetings.map((g, i) => `${i + 1}. ${g}`).join("\n")
        : "(未生成)";
      showResult("## 💬 打招呼语候选\n\n" + items +
        "\n\n> 直接复制粘贴给 HR 即可");
    } catch (e) { showResult("❌ " + e.message); }
    finally { setBusy(false); }
  }

  async function doChat() {
    setBusy(true);
    try {
      const job = collectJob();
      const msg = window.prompt("粘贴 HR 发来的最新消息（可留空）:", "");
      if (msg === null) { setBusy(false); return; }
      const data = await callBackend("/ext/chat-tone", await withResume({ ...job, message: msg }));
      const items = (data.suggestions || []).filter(Boolean)
        .map((s) => "- " + s).join("\n");
      showResult("## 🧠 HR 话术建议\n\n" + (items || "(无)"));
    } catch (e) { showResult("❌ " + e.message); }
    finally { setBusy(false); }
  }

  // ============================== 复制 / 收藏 / 历史 ==============================

  async function doCopy() {
    if (!lastResult) return;
    // 复制渲染后的纯文本（适合直接粘贴进 HR 聊天框）
    const payload = (els.resultBody && els.resultBody.innerText)
      ? els.resultBody.innerText.trim() : lastResult;
    try {
      await navigator.clipboard.writeText(payload);
      els.copyBtn.textContent = "✓ 已复制";
      setTimeout(() => (els.copyBtn.textContent = "📋 复制"), 1200);
    } catch (e) {
      // 剪贴板权限不足时降级
      const ta = document.createElement("textarea");
      ta.value = payload;
      document.body.appendChild(ta);
      ta.select();
      try {
        if (!document.execCommand("copy")) window.prompt("复制到剪贴板:", payload);
      } catch (_) {
        window.prompt("复制到剪贴板:", payload);
      }
      document.body.removeChild(ta);
    }
  }

  async function getHistory() {
    if (historyCache) return historyCache;
    const s = await storageGet([STORE_HISTORY]);
    let list = [];
    try { list = JSON.parse(s[STORE_HISTORY] || "[]"); } catch (_) {}
    if (!Array.isArray(list)) list = [];
    historyCache = list;
    return list;
  }

  async function saveHistory(list) {
    historyCache = list.slice(0, MAX_HISTORY);
    await storageSet({ [STORE_HISTORY]: JSON.stringify(historyCache) });
  }

  async function doFavorite() {
    try {
      const job = collectJob();
      const entry = {
        t: Date.now(),
        ts: new Date().toLocaleString(),
        title: job.title || "未识别岗位",
        company: job.company || "",
        salary: job.salary || "",
        url: job.url || "",
        result: lastResult || "",
      };
      const list = await getHistory();
      list.unshift(entry);
      await saveHistory(list);
      els.favBtn.textContent = "✓ 已收藏";
      setTimeout(() => (els.favBtn.textContent = "⭐ 收藏"), 1200);
    } catch (e) {
      showResult("❌ 收藏失败: " + e.message);
    }
  }

  async function renderHistory() {
    const list = await getHistory();
    els.historyList.innerHTML = "";
    if (!list.length) {
      els.historyList.textContent = "(暂无收藏/历史，点「⭐ 收藏」保存当前职位分析)";
      return;
    }
    list.forEach((it, idx) => {
      const row = document.createElement("div");
      row.className = "history-item";
      row.innerHTML =
        `<div class="h-title"></div>` +
        `<div class="h-meta"></div>` +
        `<button class="ghost small h-del" data-i="${idx}">🗑</button>`;
      row.querySelector(".h-title").textContent = it.title + (it.salary ? " · " + it.salary : "");
      row.querySelector(".h-meta").textContent = (it.company || "") + " " + (it.ts || "");
      row.title = it.result || it.url || "";
      row.querySelector(".h-del").addEventListener("click", async (e) => {
        e.stopPropagation();
        const nl = await getHistory();
        nl.splice(idx, 1);
        await saveHistory(nl);
        renderHistory();
      });
      row.addEventListener("click", () => { if (it.result) showResult(it.result); });
      els.historyList.appendChild(row);
    });
  }

  function toggleHistory(show) {
    els.historyPanel.classList.toggle("hidden", !show);
    if (show) renderHistory();
  }

  // ============================== 设置 ==============================

  async function openSettings() {
    const s = await storageGet(["bossassist_base"]);
    const cur = s.bossassist_base || DEFAULT_BASE;
    const v = window.prompt("后端地址(留空恢复默认):", cur);
    if (v === null) return;
    const base = (v && v.trim()) ? v.trim().replace(/\/+$/, "") : DEFAULT_BASE;
    await storageSet({ bossassist_base: base });
    checkBackend();
  }

  // ============================== 事件绑定 ==============================

  function wireEvents() {
    els.jobConfirm.addEventListener("click", confirmJob);
    els.jobReload.addEventListener("click", () => initRead());
    els.btnMods.addEventListener("click", () => els.modPanel.classList.toggle("hidden"));
    els.btnAssess.addEventListener("click", doAssess);
    els.btnPack.addEventListener("click", doPack);
    els.btnAnalysis.addEventListener("click", doAnalysis);
    els.btnPlan.addEventListener("click", doPlan);
    els.btnCompany.addEventListener("click", doCompany);
    els.btnSalary.addEventListener("click", doSalary);
    els.btnIntro.addEventListener("click", doIntro);
    els.btnStar.addEventListener("click", doStar);
    els.btnSummary.addEventListener("click", doSummary);
    els.btnInterview.addEventListener("click", doInterview);
    els.btnOptimize.addEventListener("click", doOptimize);
    els.btnGreeting.addEventListener("click", doGreeting);
    els.btnChat.addEventListener("click", doChat);
    els.copyBtn.addEventListener("click", doCopy);
    els.favBtn.addEventListener("click", doFavorite);
    els.resumePick.addEventListener("click", pickResume);
    els.resumeFile.addEventListener("change", onResumeFile);
    els.resumeView.addEventListener("click", toggleResumeView);
    els.resumeClear.addEventListener("click", clearResume);
    els.settings.addEventListener("click", openSettings);
    els.historyBtn.addEventListener("click", () => toggleHistory(true));
    els.historyClose.addEventListener("click", () => toggleHistory(false));
    els.refresh.addEventListener("click", initRead);
    els.closeBtn.addEventListener("click", () => togglePanel(false));
  }

  // ============================== 消息与启动 ==============================

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "TOGGLE_PANEL") {
      togglePanel();
      sendResponse({ ok: true, visible: panelVisible });
    }
    return false;
  });

  // 翻页/刷新后自动恢复侧边栏（上次是打开状态则保持打开）
  (async () => {
    const s = await storageGet(["bossassist_panel_open"]);
    if (s.bossassist_panel_open) togglePanel(true);
  })();

  // 便于调试（open 模式下不可见 closed shadow，这里暴露只读工具）
  window.__BOSS_ASSIST__ = { extractJob, togglePanel };
})();
