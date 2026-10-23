/* 管理页数据层 store.js —— /api/* 薄封装 + 本地 fallback（plan/03 §7）。
 *
 * 约定：
 *  - 走 background 代理（{type:'API', path, method, body}）发请求，3 秒超时；
 *  - 后端不可达时管理页降级「本地模式」：从 chrome.storage 读 bossassist_history
 *    能读多少读多少（T10），页面永不白屏；
 *  - 离线队列 bossassist_outbox 由 flushOutbox() 补传（T11）；
 *  - 一切用户内容入库/上屏前先过 escapeHtml / safeUrl（T9 XSS）。
 */
window.Store = (function () {
  "use strict";

  var DEFAULT_BASE = "http://127.0.0.1:8000";
  var TIMEOUT_MS = 3000;

  // ---------- 底层：chrome.storage 小助手 ----------
  function storageGet(keys) {
    return new Promise(function (resolve) {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(keys, function (res) { resolve(res || {}); });
      } else {
        resolve({});
      }
    });
  }
  function storageSet(obj) {
    return new Promise(function (resolve) {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set(obj, function () { resolve(); });
      } else {
        resolve();
      }
    });
  }

  // ---------- 安全工具（T9）----------
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function safeUrl(u) {
    var s = String(u || "").trim();
    return /^https?:\/\//i.test(s) ? s : ""; // 只放行 http/https
  }

  // ---------- 请求：background 代理 + 3s 超时 ----------
  function getBase() {
    return storageGet(["bossassist_base"]).then(function (res) {
      return res.bossassist_base || DEFAULT_BASE;
    });
  }

  function api(method, path, body) {
    var req = new Promise(function (resolve) {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        try {
          chrome.runtime.sendMessage({ type: "API", path: path, method: method, body: body }, function (resp) {
            if (chrome.runtime.lastError) {
              resolve({ ok: false, error: chrome.runtime.lastError.message });
            } else if (!resp) {
              resolve({ ok: false, error: "background 无响应" });
            } else {
              resolve(resp);
            }
          });
        } catch (e) {
          resolve({ ok: false, error: String(e) });
        }
      } else {
        // 非扩展环境（调试用）：直接 fetch
        fetch((window.__BASE__ || DEFAULT_BASE) + path, {
          method: method,
          headers: { "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        }).then(function (r) {
          return r.json().then(function (d) { resolve({ ok: r.ok, status: r.status, data: d }); });
        }).catch(function (e) { resolve({ ok: false, error: String(e) }); });
      }
    });
    var timeout = new Promise(function (resolve) {
      setTimeout(function () { resolve({ ok: false, error: "请求超时" }); }, TIMEOUT_MS);
    });
    return Promise.race([req, timeout]).then(function (resp) {
      // 统一形态：{ok, status?, data?, error?}
      // background 的 ok 是 HTTP 层：4xx/5xx 时业务错误体在 data.error，提升到顶层供调用方统一读取
      if (resp && !resp.ok && !resp.error && resp.data && typeof resp.data === "object" && resp.data.error) {
        resp.error = resp.data.error;
      }
      return resp;
    });
  }

  // ---------- 一次性提示（不弹窗、不阻塞）----------
  var noticeTimer = null;
  function notice(msg, isErr) {
    if (typeof document === "undefined") return;
    var el = document.getElementById("one-shot-notice");
    if (!el) {
      el = document.createElement("div");
      el.id = "one-shot-notice";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = "one-shot-notice show" + (isErr ? " err" : "");
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () { el.className = "one-shot-notice"; }, 2500);
  }

  // ---------- 离线队列补传（T11：断网分析 → 联网后开管理页全量补传）----------
  function flushOutbox() {
    return storageGet(["bossassist_outbox"]).then(function (res) {
      var q = res.bossassist_outbox || [];
      if (!q.length) return { ok: true, flushed: 0 };
      return api("POST", "/api/events", { events: q }).then(function (resp) {
        if (resp && resp.ok) {
          var n = q.length;
          return storageSet({ bossassist_outbox: [], bossassist_last_sync: Date.now() }).then(function () {
            return { ok: true, flushed: n, data: resp.data };
          });
        }
        // 失败：静默保留队列，等下次（plan/04 §2）
        return { ok: false, error: (resp && resp.error) || "后端不可达", flushed: 0 };
      });
    });
  }

  // ---------- 本地模式 fallback（T10）----------
  function localJobs() {
    return storageGet(["bossassist_history", "bossassist_outbox"]).then(function (res) {
      var seen = {};
      var items = [];
      function push(it) {
        var key = String(it.url || it.title || "").replace(/[?#].*$/, "").replace(/\/+$/, "");
        if (!key || seen[key]) return;
        seen[key] = 1;
        items.push({
          title: it.title || "", company: it.company || "", salary_raw: it.salary || it.salary_raw || "",
          url: it.url || "", is_favorite: 1, status: "viewed", match_score: null,
          last_seen_at: it.ts || it.at || 0, _local: 1,
        });
      }
      // bossassist_history 存的是 JSON 字符串（content_script 序列化写入），兜一层解析（T10 本地模式）
      var hist = res.bossassist_history || [];
      if (typeof hist === "string") {
        try { hist = JSON.parse(hist) || []; } catch (_) { hist = []; }
      }
      if (!Array.isArray(hist)) hist = [];
      hist.forEach(push);
      (res.bossassist_outbox || []).forEach(function (e) {
        if (e && e.payload && (e.type === "favorite" || e.type === "view")) push(e.payload);
      });
      return items;
    });
  }

  // ---------- 对外 API（plan/03 §7 清单）----------
  return {
    DEFAULT_BASE: DEFAULT_BASE,
    escapeHtml: escapeHtml,
    safeUrl: safeUrl,
    notice: notice,
    getBase: getBase,
    api: api,

    ping: function () { return api("GET", "/api/health"); },
    stats: function (days) { return api("GET", "/api/stats" + (days ? "?days=" + days : "")); },

    listJobs: function (params) {
      var qs = [];
      Object.keys(params || {}).forEach(function (k) {
        var v = params[k];
        if (v !== undefined && v !== null && v !== "") qs.push(k + "=" + encodeURIComponent(v));
      });
      return api("GET", "/api/jobs" + (qs.length ? "?" + qs.join("&") : ""));
    },
    getJob: function (id) { return api("GET", "/api/jobs/" + id); },
    createJob: function (body) { return api("POST", "/api/jobs", body); },
    patchJob: function (id, body) { return api("PATCH", "/api/jobs/" + id, body); },
    bulkJobs: function (body) { return api("POST", "/api/jobs/bulk", body); },

    listApplications: function (params) {
      var qs = [];
      Object.keys(params || {}).forEach(function (k) {
        if (params[k] !== undefined && params[k] !== null && params[k] !== "") {
          qs.push(k + "=" + encodeURIComponent(params[k]));
        }
      });
      return api("GET", "/api/applications" + (qs.length ? "?" + qs.join("&") : ""));
    },
    createApplication: function (body) { return api("POST", "/api/applications", body); },
    patchApplication: function (id, body) { return api("PATCH", "/api/applications/" + id, body); },
    deleteApplication: function (id) { return api("DELETE", "/api/applications/" + id); },

    listResumes: function () { return api("GET", "/api/resumes"); },
    getResume: function (id) { return api("GET", "/api/resumes/" + id); },
    saveResume: function (body) { return api("POST", "/api/resumes", body); },
    patchResume: function (id, body) { return api("PATCH", "/api/resumes/" + id, body); },
    deleteResume: function (id) { return api("DELETE", "/api/resumes/" + id); },

    getSettings: function () { return api("GET", "/api/settings"); },
    putSettings: function (body) { return api("PUT", "/api/settings", body); },

    exportData: function (format) { return api("GET", "/api/export?format=" + (format || "json")); },
    importData: function (body) { return api("POST", "/api/import", body); },
    resetAll: function () { return api("POST", "/api/reset", { confirm: true }); },
    // v3.6.0：求职行动闭环 —— 跟进记录 / 周报 / 简历导出
    postEvent: function (ev) { return api("POST", "/api/events", { events: [ev] }); },
    weeklyReport: function () { return api("GET", "/api/report/weekly"); },
    exportResume: function (id, format) { return api("GET", "/api/resumes/" + id + "/export?format=" + (format || "md")); },
    // v3.7.0：JD 关键词缺口 / 薪酬区间对比
    keywordGap: function (body) { return api("POST", "/api/keyword-gap", body); },
    salaryCompare: function (days) { return api("GET", "/api/salary/compare?days=" + (days || 30)); },

    flushOutbox: flushOutbox,
    localJobs: localJobs,
    storageGet: storageGet,
    storageSet: storageSet,
  };
})();
