// 后台脚本（MV3 service worker）：
//   1) 点击工具栏图标 → 通知当前页 content script 切换右侧常驻侧边栏
//   2) 代理侧边栏的本地后端请求（http://127.0.0.1:8000/ext/*）
//      —— content script 直接 fetch 本地后端会被页面 CORS 拦，统一走后台转发。

const DEFAULT_BASE = "http://127.0.0.1:8000";

// MV3 用 chrome.action；保留 browserAction 回退以兼容旧运行时
const actionApi = chrome.action || chrome.browserAction;

function storageGet(keys) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(keys, (v) => resolve(v || {}));
    } catch (_) {
      resolve({});
    }
  });
}

async function getBase() {
  const s = await storageGet(["bossassist_base"]);
  return (s.bossassist_base || DEFAULT_BASE).replace(/\/+$/, "");
}

function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(resp || null);
    });
  });
}

function injectContentScript(tabId) {
  return new Promise((resolve) => {
    if (chrome.scripting && chrome.scripting.executeScript) {
      // MV3：md.js（Markdown 渲染器）必须先于 content_script.js 注入
      chrome.scripting.executeScript(
        { target: { tabId }, files: ["md.js", "content_script.js"] },
        () => resolve()
      );
    } else if (chrome.tabs.executeScript) {
      // MV2 回退（如 Firefox 旧版）：逐个注入保持顺序
      chrome.tabs.executeScript(tabId, { file: "md.js" }, () => {
        chrome.tabs.executeScript(tabId, { file: "content_script.js" }, () => resolve());
      });
    } else {
      resolve();
    }
  });
}

// ---- 点击图标：切换侧边栏 ----
actionApi.onClicked.addListener((tab) => {
  if (!tab || tab.id == null) return;
  (async () => {
    let resp = await sendToTab(tab.id, { type: "TOGGLE_PANEL" });
    if (resp) return;
    // content script 未注入（如装插件之前就已打开的页面）→ 先注入再切换
    await injectContentScript(tab.id);
    await sendToTab(tab.id, { type: "TOGGLE_PANEL" });
  })();
});

// ---- 后端请求代理 ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "API") return false;
  (async () => {
    try {
      const base = await getBase();
      const method = msg.method || (msg.body ? "POST" : "GET");
      const opt = { method, headers: { "Content-Type": "application/json" } };
      if (msg.body && method !== "GET") opt.body = JSON.stringify(msg.body);
      const r = await fetch(base + msg.path, opt);
      const text = await r.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch (_) {
        data = text;
      }
      sendResponse({ ok: r.ok, status: r.status, data });
    } catch (e) {
      sendResponse({ ok: false, error: (e && e.message) || String(e) });
    }
  })();
  return true; // 异步响应
});
