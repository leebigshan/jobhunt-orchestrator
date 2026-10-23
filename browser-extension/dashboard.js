/* 管理页逻辑 dashboard.js —— 四 Tab（概览/职位管理/申请记录/设置），零框架、hash 路由。
 * 所有用户内容经 Store.escapeHtml 上屏（T9），链接只放行 http/https（safeUrl）。
 * 后端不可达 → 黄条本地模式 + chrome.storage 本地数据兜底（T10）。
 */
(function () {
  "use strict";

  var S = window.Store;
  var esc = S.escapeHtml;
  var $ = function (id) { return document.getElementById(id); };

  var STATUS_LABEL = {
    viewed: "已查看", applied: "已投递", read: "已读", interview: "面试中",
    offer: "Offer", rejected: "已拒绝", archived: "已归档",
  };
  var STATUS_ORDER = ["viewed", "applied", "read", "interview", "offer"]; // 主链
  var EV_LABEL = {
    view: "浏览", analyze: "分析", favorite: "收藏", unfavorite: "取消收藏",
    apply: "投递", stage: "阶段", note: "备注",
  };

  // 状态机镜像（web/db.py can_transit）：主链只进不退；applied→offer 放行；任意→rejected/archived
  function canTransit(from, to) {
    if (from === to) return false;
    if (to === "rejected" || to === "archived") return from !== "rejected" && from !== "archived";
    if (from === "offer" || from === "rejected") return false;
    if (from === "applied" && to === "offer") return true;
    var fi = STATUS_ORDER.indexOf(from), ti = STATUS_ORDER.indexOf(to);
    return fi >= 0 && ti > fi && ti <= STATUS_ORDER.indexOf("interview") + 1;
  }

  function fmtTs(ms) {
    if (!ms) return "—";
    var d = new Date(ms);
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function pct(x) { return x === null || x === undefined ? "—" : (x * 100).toFixed(1) + "%"; }
  function num(x) { return x === null || x === undefined ? "—" : String(x); }

  // ================= 路由 =================
  function parseHash() {
    var h = location.hash.replace(/^#\/?/, "") || "overview";
    var parts = h.split("?");
    var tab = parts[0] || "overview";
    var params = {};
    (parts[1] || "").split("&").forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf("=");
      params[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
    });
    return { tab: tab, params: params };
  }
  function go(tab, params) {
    var qs = [];
    Object.keys(params || {}).forEach(function (k) {
      if (params[k] !== "" && params[k] !== undefined && params[k] !== null) {
        qs.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
      }
    });
    location.hash = "#/" + tab + (qs.length ? "?" + qs.join("&") : "");
  }
  function route() {
    var r = parseHash();
    ["overview", "jobs", "applications", "settings"].forEach(function (t) {
      $("page-" + t).hidden = t !== r.tab;
    });
    Array.prototype.forEach.call(document.querySelectorAll("#tabs a"), function (a) {
      a.classList.toggle("active", a.getAttribute("data-tab") === r.tab);
    });
    if (r.tab === "overview") loadOverview();
    else if (r.tab === "jobs") loadJobs(r.params);
    else if (r.tab === "applications") loadApplications(r.params);
    else if (r.tab === "settings") loadSettings();
  }
  window.addEventListener("hashchange", route);

  // ================= 后端状态 + 本地模式 =================
  var backendUp = true;
  function setBackendState(up) {
    backendUp = up;
    $("backend-dot").className = "dot " + (up ? "ok" : "down");
    $("backend-label").textContent = up ? "后端已连接" : "后端未连接";
    $("local-banner").hidden = up;
    if (!up) {
      S.getBase().then(function (b) { $("local-base").textContent = b; });
    }
  }
  function checkBackend() {
    return S.ping().then(function (resp) {
      setBackendState(!!(resp && resp.ok));
      return !!(resp && resp.ok);
    });
  }

  // ================= 概览 =================
  function loadOverview() {
    $("ov-trend").innerHTML = '<div class="state">加载中…</div>';
    $("ov-dist").innerHTML = '<div class="state">加载中…</div>';
    $("ov-recent").innerHTML = '<li class="state">加载中…</li>';
    $("ov-salary").innerHTML = '<div class="state">加载中…</div>';
    S.stats(30).then(function (resp) {
      if (!(resp && resp.ok)) return renderOverviewLocal();
      var d = resp.data || resp;
      // 六卡
      $("ov-jobs").textContent = num(d.totals.jobs);
      $("ov-analyzed").textContent = num(d.totals.analyzed);
      $("ov-applied").textContent = num(d.totals.applied);
      $("ov-reply").textContent = pct(d.rates.reply);
      $("ov-interview").textContent = pct(d.rates.interview);
      $("ov-score").textContent = d.avg_match_score === null ? "—" : d.avg_match_score;
      $("ov-followups").textContent = String((d.followups || []).length);
      renderTrend(d.trend);
      renderDist(d.score_dist);
      renderRecent(d.recent);
      renderSalary();
      if (!d.totals.jobs) {
        $("ov-recent").innerHTML = '<li class="state">还没有数据。去 BOSS 页面浏览职位 → 点「评估」，数据会自动汇总到这里。' +
          '<br>也可以到「设置 → 数据」导入旧版历史。</li>';
      }
    });
  }
  function renderSalary() {
    // v3.7.0：薪酬区间对比（近 30 天浏览 + 全部收藏），纯规则 0 token
    S.salaryCompare(30).then(function (resp) {
      if (!(resp && resp.ok)) {
        $("ov-salary").innerHTML = '<div class="state">薪酬数据不可用（后端未连接）</div>';
        return;
      }
      var d = resp.data || resp;
      var items = d.items || [];
      if (!items.length) {
        $("ov-salary").innerHTML = '<div class="state">暂无可对比的薪酬数据。先去 BOSS 页面浏览带薪资的职位，或到职位详情收藏。</div>';
        return;
      }
      var maxK = d.scale_max_k || 100;
      var rows = items.map(function (it) {
        var lo = (it.low_k === null || it.low_k === undefined) ? it.high_k : it.low_k;
        var hi = (it.high_k === null || it.high_k === undefined) ? it.low_k : it.high_k;
        lo = lo || 0; hi = hi || lo;
        var left = Math.max(0, Math.min(100, (lo / maxK) * 100));
        var w = Math.max(2, Math.min(100 - left, ((hi - lo) / maxK) * 100));
        return '<div class="sal-row">' +
          '<span class="sal-label" title="' + esc(it.title || "") + '（' + esc(it.company || "") + '）">' +
          (it.is_favorite ? "★" : "") + esc(it.title || "（未命名）") + '</span>' +
          '<span class="sal-track"><span class="sal-span" style="left:' + left + '%;width:' + w + '%"></span></span>' +
          '<span class="sal-val">' + esc(it.salary_raw || ((lo || "?") + "-" + (hi || "?") + "K")) + '</span>' +
          '</div>';
      }).join("");
      var s = d.stats || {};
      $("ov-salary").innerHTML = rows +
        '<div class="sal-stats hint">共 ' + (s.count || 0) + ' 条 · 区间 ' + (s.min_low_k || "?") + 'K ~ ' + (s.max_high_k || "?") +
        'K · 均值 ' + (s.avg_low_k || "?") + '-' + (s.avg_high_k || "?") + 'K · 中位 ' + (s.median_k || "?") + 'K</div>';
    });
  }
  function renderOverviewLocal() {
    // T10：本地模式 —— 显示本地收藏，数字留 —
    ["ov-jobs", "ov-analyzed", "ov-applied", "ov-reply", "ov-interview", "ov-score", "ov-followups"].forEach(function (id) {
      $(id).textContent = "—";
    });
    $("ov-trend").innerHTML = '<div class="state">本地模式：图表不可用</div>';
    $("ov-dist").innerHTML = '<div class="state">本地模式：图表不可用</div>';
    $("ov-salary").innerHTML = '<div class="state">本地模式：薪酬对比不可用</div>';
    S.localJobs().then(function (items) {
      if (!items.length) {
        $("ov-recent").innerHTML = '<li class="state">本地也没有缓存数据。连接后端后点「↻ 同步」。</li>';
        return;
      }
      $("ov-recent").innerHTML = items.slice(0, 20).map(function (it) {
        return '<li><span class="ts">' + esc(fmtTs(it.last_seen_at)) + '</span>' +
          '<span class="ev-type">本地</span>' +
          '<a class="title-link" href="' + esc(S.safeUrl(it.url)) + '" target="_blank" rel="noopener">' + esc(it.title) + "</a> " +
          esc(it.company) + " " + esc(it.salary_raw) + "</li>";
      }).join("");
    });
  }
  function renderTrend(trend) {
    if (!trend || !trend.length) {
      $("ov-trend").innerHTML = '<div class="state">暂无趋势数据</div>';
      return;
    }
    var W = 640, H = 180, PAD = 30, TICKS = 4;
    var max = 1;
    trend.forEach(function (p) { max = Math.max(max, p.views, p.applies); });
    max = Math.ceil(max * 1.1);
    var n = trend.length;
    var x = function (i) { return PAD + (W - PAD * 2) * (n === 1 ? 0.5 : i / (n - 1)); };
    var y = function (v) { return H - PAD - (H - PAD * 2) * (v / max); };
    function poly(key, color) {
      return '<polyline fill="none" stroke="' + color + '" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" points="' +
        trend.map(function (p, i) { return x(i) + "," + y(p[key]); }).join(" ") + '"/>';
    }
    // 网格线 + Y 轴刻度
    var grid = "";
    for (var t = 0; t <= TICKS; t++) {
      var gy = PAD + (H - PAD * 2) * (t / TICKS);
      var val = Math.round(max * (1 - t / TICKS));
      grid += '<line class="grid-line" x1="' + PAD + '" y1="' + gy + '" x2="' + (W - PAD) + '" y2="' + gy + '"/>';
      grid += '<text class="axis-text" x="' + (PAD - 5) + '" y="' + (gy + 3) + '" text-anchor="end">' + val + "</text>";
    }
    var labels = "";
    for (var i = 0; i < n; i += Math.max(1, Math.floor(n / 5))) {
      labels += '<text class="axis-text" x="' + x(i) + '" y="' + (H - 9) + '" text-anchor="middle">' +
        esc(trend[i].date.slice(5)) + "</text>";
    }
    // 悬停 tooltip（纯 CSS hover，不影响点击筛选）
    var dots = "";
    trend.forEach(function (p, i) {
      dots += '<g class="tr-dot">' +
        '<circle cx="' + x(i) + '" cy="' + y(p.views) + '" r="3.5" fill="#3b6cf6"/>' +
        '<circle cx="' + x(i) + '" cy="' + y(p.applies) + '" r="3.5" fill="#f5a623"/>' +
        '<title class="chart-tip">'+ esc(trend[i].date) +'：浏览 '+ p.views +'，投递 '+ p.applies +'</title></g>';
    });
    $("ov-trend").innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '">' +
      grid + poly("views", "#3b6cf6") + poly("applies", "#f5a623") + dots + labels + "</svg>";
  }
  function renderDist(dist) {
    if (!dist || !dist.length) {
      $("ov-dist").innerHTML = '<div class="state">暂无评分数据</div>';
      return;
    }
    var W = 400, H = 180, PAD = 30, TICKS = 4;
    var max = 1;
    dist.forEach(function (b) { max = Math.max(max, b.n); });
    max = Math.ceil(max * 1.1);
    var bw = (W - PAD * 2) / dist.length;
    var grid = "";
    for (var t = 0; t <= TICKS; t++) {
      var gy = PAD + (H - PAD * 2) * (t / TICKS);
      var val = Math.round(max * (1 - t / TICKS));
      grid += '<line class="grid-line" x1="' + PAD + '" y1="' + gy + '" x2="' + (W - PAD) + '" y2="' + gy + '"/>';
      grid += '<text class="axis-text" x="' + (PAD - 5) + '" y="' + (gy + 3) + '" text-anchor="end">' + val + "</text>";
    }
    var bars = dist.map(function (b, i) {
      var h = (H - PAD * 2) * (b.n / max);
      var parts = b.bucket.split("-");
      return '<g class="dist-bar" data-min="' + parts[0] + '" data-max="' + parts[1] + '">' +
        '<rect x="' + (PAD + i * bw + bw * 0.2) + '" y="' + (H - PAD - h) + '" width="' + bw * 0.6 +
        '" height="' + Math.max(h, 1) + '" rx="5" fill="#3b6cf6"/>' +
        '<text x="' + (PAD + i * bw + bw / 2) + '" y="' + (H - PAD - h - 6) + '" font-size="11" fill="#374151" text-anchor="middle">' + b.n + "</text>" +
        '<text x="' + (PAD + i * bw + bw / 2) + '" y="' + (H - 11) + '" font-size="10" fill="#aeb4c0" text-anchor="middle">' + esc(b.bucket) + "</text>" +
        '<title class="chart-tip">'+ esc(b.bucket) +' 分：'+ b.n +' 个职位</title></g>';
    }).join("");
    $("ov-dist").innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '">' +
      grid + bars + "</svg>";
    Array.prototype.forEach.call($("ov-dist").querySelectorAll(".dist-bar"), function (g) {
      g.addEventListener("click", function () {
        go("jobs", { min_score: g.getAttribute("data-min"), max_score: g.getAttribute("data-max") });
      });
    });
  }
  function renderRecent(recent) {
    if (!recent || !recent.length) {
      $("ov-recent").innerHTML = '<li class="state">暂无动态</li>';
      return;
    }
    $("ov-recent").innerHTML = recent.map(function (e) {
      var url = e.url ? S.safeUrl(e.url) : "";
      var t = url ? '<a class="title-link" href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(e.title || "（无标题）") + "</a>" : esc(e.title || "（无标题）");
      return '<li><span class="ts">' + esc(fmtTs(e.at)) + "</span>" +
        '<span class="ev-type">' + esc(EV_LABEL[e.type] || e.type) + "</span>" + t + " · " + esc(e.company) + "</li>";
    }).join("");
  }

  // ================= 职位管理 =================
  var PAGE_SIZE = 20;
  function loadJobs(params) {
    params = params || {};
    // 筛选回填（hash 优先，其次 storage）
    S.storageGet(["bossassist_dash_filters"]).then(function (res) {
      var saved = params.q !== undefined || params.status !== undefined ? params
        : Object.assign({}, res.bossassist_dash_filters || {}, params);
      $("f-q").value = saved.q || "";
      $("f-status").value = saved.status || "";
      $("f-min-score").value = saved.min_score || "";
      $("f-max-score").value = saved.max_score || "";
      $("f-min-salary").value = saved.min_salary || "";
      $("f-fav").checked = saved.fav === "1" || saved.fav === 1;
      $("f-sort").value = saved.sort || "last_seen";
      var page = parseInt(saved.page || "1", 10) || 1;
      fetchJobs(page);
    });
  }
  function currentFilters() {
    return {
      q: $("f-q").value.trim(),
      status: $("f-status").value,
      min_score: $("f-min-score").value,
      max_score: $("f-max-score").value,
      min_salary: $("f-min-salary").value,
      fav: $("f-fav").checked ? "1" : "",
      sort: $("f-sort").value,
    };
  }
  function fetchJobs(page) {
    var f = currentFilters();
    f.page = page;
    S.storageSet({ bossassist_dash_filters: f });
    $("jobs-state").hidden = false;
    $("jobs-state").textContent = "加载中…";
    $("jobs-tbody").innerHTML = "";
    var args = {
      q: f.q, status: f.status, min_score: f.min_score, max_score: f.max_score,
      min_salary: f.min_salary, favorite: f.fav, sort: f.sort,
      limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE,
    };
    S.listJobs(args).then(function (resp) {
      if (!(resp && resp.ok)) {
        // 本地模式兜底（T10）
        return S.localJobs().then(function (items) {
          $("jobs-state").hidden = items.length > 0;
          $("jobs-state").textContent = "本地模式：仅显示本地缓存";
          $("jobs-tbody").innerHTML = items.slice(0, PAGE_SIZE).map(function (it) {
            return "<tr><td></td><td>" + linkCell(it.url, it.title) + "</td><td>" + esc(it.company) +
              '</td><td class="mono">' + esc(it.salary_raw) + "</td><td>—</td><td>" +
              pill("viewed", 0) + "</td><td class=\"mono\">" + esc(fmtTs(it.last_seen_at)) + "</td></tr>";
          }).join("");
          $("jobs-pager").innerHTML = "";
        });
      }
      var items = (resp.data || resp).items || [];
      var total = (resp.data || resp).total || 0;
      $("jobs-state").hidden = items.length > 0;
      if (!items.length) $("jobs-state").textContent = "没有符合条件的职位";
      $("jobs-tbody").innerHTML = items.map(rowHtml).join("");
      bindRowEvents(items);
      renderPager(page, total);
    });
  }
  function linkCell(url, title) {
    var u = S.safeUrl(url);
    return u ? '<a class="title-link" href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(title || "（无标题）") + "</a>"
      : esc(title || "（无标题）");
  }
  function pill(status, id) {
    return '<button class="pill ' + esc(status) + '" data-id="' + id + '" data-status="' + esc(status) + '">' +
      esc(STATUS_LABEL[status] || status) + "</button>";
  }
  function scoreCell(j) {
    if (j.match_score === null || j.match_score === undefined) return "—";
    var cls = j.match_score >= 80 ? "hi" : (j.match_score >= 60 ? "mid" : "lo");
    return '<div class="score-cell"><span class="mono">' + j.match_score + "</span>" +
      (j.engine ? '<span class="engine-badge">' + esc(j.engine) + "</span>" : "") +
      '<div class="score-bar ' + cls + '"><i style="width:' + Math.max(2, Math.min(100, j.match_score)) + '%"></i></div></div>';
  }
  function rowHtml(j) {
    return '<tr data-id="' + j.id + '">' +
      '<td><input type="checkbox" class="row-chk" data-id="' + j.id + '"></td>' +
      "<td>" + linkCell(j.url, j.title) + "</td>" +
      "<td>" + esc(j.company || "—") + "</td>" +
      '<td class="mono">' + esc(j.salary_raw || "—") + "</td>" +
      "<td>" + scoreCell(j) + "</td>" +
      "<td>" + pill(j.status, j.id) + "</td>" +
      '<td class="mono">' + esc(fmtTs(j.last_seen_at)) + "</td></tr>";
  }
  function bindRowEvents(items) {
    Array.prototype.forEach.call($("jobs-tbody").querySelectorAll("tr"), function (tr) {
      tr.addEventListener("click", function (e) {
        if (e.target.closest("input,button,a")) return;
        openDrawer(parseInt(tr.getAttribute("data-id"), 10));
      });
    });
    Array.prototype.forEach.call($("jobs-tbody").querySelectorAll(".pill"), function (p) {
      p.addEventListener("click", function (e) {
        e.stopPropagation();
        openStatusMenu(p);
      });
    });
    Array.prototype.forEach.call($("jobs-tbody").querySelectorAll(".row-chk"), function (c) {
      c.addEventListener("change", function (e) {
        e.stopPropagation();
        c.closest("tr").classList.toggle("selected", c.checked);
        updateBulkBar();
      });
    });
  }
  function openStatusMenu(pillBtn) {
    var id = parseInt(pillBtn.getAttribute("data-id"), 10);
    var from = pillBtn.getAttribute("data-status");
    var sel = document.createElement("select");
    sel.innerHTML = Object.keys(STATUS_LABEL).map(function (s) {
      return '<option value="' + s + '"' + (s === from ? " selected" : "") +
        (canTransit(from, s) || s === from ? "" : " disabled") + ">" + STATUS_LABEL[s] + "</option>";
    }).join("");
    pillBtn.replaceWith(sel);
    sel.focus();
    sel.addEventListener("change", function () {
      var to = sel.value;
      if (to === from) return;
      S.patchJob(id, { status: to }).then(function (resp) {
        if (resp && resp.ok) {
          S.notice("状态已更新为 " + STATUS_LABEL[to]);
          fetchJobs(parseInt($("jobs-pager").getAttribute("data-page") || "1", 10));
        } else {
          S.notice("状态流转被拒：" + ((resp && resp.error) || "服务端校验未通过"), true);
          fetchJobs(parseInt($("jobs-pager").getAttribute("data-page") || "1", 10));
        }
      });
    });
    sel.addEventListener("blur", function () {
      fetchJobs(parseInt($("jobs-pager").getAttribute("data-page") || "1", 10));
    });
  }
  function updateBulkBar() {
    var n = document.querySelectorAll(".row-chk:checked").length;
    $("bulk-bar").hidden = n === 0;
    $("bulk-count").textContent = n;
  }
  function renderPager(page, total) {
    var pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    $("jobs-pager").setAttribute("data-page", page);
    $("jobs-pager").innerHTML =
      '<button class="btn" id="pg-prev"' + (page <= 1 ? " disabled" : "") + ">上一页</button>" +
      "<span>第 " + page + " / " + pages + " 页 · 共 " + total + " 条</span>" +
      '<button class="btn" id="pg-next"' + (page >= pages ? " disabled" : "") + ">下一页</button>";
    var prev = $("pg-prev"), next = $("pg-next");
    if (prev) prev.addEventListener("click", function () { fetchJobs(page - 1); });
    if (next) next.addEventListener("click", function () { fetchJobs(page + 1); });
  }

  // ---- 详情抽屉 ----
  function openDrawer(id) {
    $("drawer-mask").hidden = false;
    $("job-drawer").hidden = false;
    $("dw-body").innerHTML = '<div class="state">加载中…</div>';
    S.getJob(id).then(function (resp) {
      if (!(resp && resp.ok)) {
        $("dw-body").innerHTML = '<div class="state err">加载失败：' + esc((resp && resp.error) || "未知错误") + "</div>";
        return;
      }
      var d = resp.data || resp;
      var j = d.job;
      $("dw-title").textContent = j.title || "职位详情";
      var url = S.safeUrl(j.url);
      var html = "";
      html += '<div class="mono" style="font-size:12px;color:#6b7280">' + esc(j.company || "") + " · " + esc(j.location || "") + " · " + esc(j.salary_raw || "") + "</div>";
      if (url) html += '<div style="margin:6px 0"><a href="' + esc(url) + '" target="_blank" rel="noopener">打开原页面 ↗</a></div>';
      html += '<div style="margin:6px 0">' + pill(j.status, j.id).replace('class="pill', 'data-static="1" style="cursor:default" class="pill') + "</div>";
      html += "<h3>职位描述（JD）</h3>";
      html += j.jd_text ? '<pre class="jd-text">' + esc(j.jd_text) + "</pre>" : '<div class="hint">本次浏览未采集到 JD 全文</div>';
      html += '<h3>🎯 关键词缺口 <span class="hint">（JD 与简历对照 · 本地规则 0 token）</span></h3>';
      html += '<button class="btn" id="dw-keygap">🎯 算一下关键词缺口</button><div id="dw-keygap-box" class="hint" style="margin-top:8px">对照默认简历（可在「简历管理」切换），JD 提到但简历没写的词就是要补的缺口。</div>';
      html += "<h3>分析结果</h3>";
      html += d.has_result || j.result_md ? (window.BOSSMD && BOSSMD.render ? '<div class="md-body">' + BOSSMD.render(j.result_md || "") + "</div>" : esc(j.result_md || "")) : '<div class="hint">还没有分析结果，去原页面点「评估」</div>';
      html += "<h3>备注</h3><textarea class=\"note-input\" id=\"dw-note\" placeholder=\"写点备注，失焦自动保存\">" + esc(j.note || "") + "</textarea>";
      html += "<h3>时间线</h3><ul class=\"timeline-mini\">" + (d.events || []).map(function (e) {
        return "<li>" + esc(fmtTs(e.at)) + " · " + esc(EV_LABEL[e.type] || e.type) + "</li>";
      }).join("") + "</ul>";
      if (!d.application) {
        html += '<div style="margin-top:16px"><button class="btn primary" id="dw-apply">标记投递</button></div>';
      } else {
        html += '<div class="hint" style="margin-top:16px">已投递 · 阶段：' + esc(STATUS_LABEL[d.application.stage] || d.application.stage) + "</div>";
      }
      $("dw-body").innerHTML = html;
      // v3.7.0：关键词缺口（点击才算，避免打开抽屉就跑）
      var kgBtn = $("dw-keygap");
      if (kgBtn) {
        kgBtn.addEventListener("click", function () {
          $("dw-keygap-box").textContent = "计算中…";
          S.keywordGap({ job_id: j.id }).then(function (r) {
            if (!(r && r.ok)) {
              $("dw-keygap-box").innerHTML = '<span class="hint">' + esc((r && r.error) || "计算失败（后端未连接？）") + "</span>";
              return;
            }
            var d = r.data || r;
            var chips = function (arr, cls) {
              return (arr && arr.length) ? arr.map(function (x) { return '<span class="kg-pill ' + cls + '">' + esc(x) + "</span>"; }).join("") : '<span class="hint">（无）</span>';
            };
            $("dw-keygap-box").innerHTML =
              '<div class="kg-line">⚠️ 简历缺口（JD 提到、简历没写）：' + chips(d.missing, "kg-missing") + "</div>" +
              '<div class="kg-line">✅ 已覆盖（JD 与简历都有）：' + chips(d.matched, "kg-matched") + "</div>" +
              '<div class="kg-line">💡 简历亮点（JD 没提，可按需取舍）：' + chips(d.extra, "kg-extra") + "</div>" +
              '<div class="hint">对照 ' + d.keywords_total + " 个关键词 · JD 命中 " + (d.jd_found || []).length +
              " · 简历命中 " + (d.resume_found || []).length + " · 简历来源 " + esc(d.resume_source || "—") + "</div>";
          });
        });
      }
      var note = $("dw-note");
      if (note) {
        note.addEventListener("blur", function () {
          S.patchJob(j.id, { note: note.value }).then(function (r) {
            if (r && r.ok) S.notice("备注已保存");
          });
        });
      }
      var applyBtn = $("dw-apply");
      if (applyBtn) {
        applyBtn.addEventListener("click", function () {
          S.createApplication({ job_id: j.id, channel: "boss" }).then(function (r) {
            if (r && r.ok) {
              S.notice("已标记投递");
              openDrawer(j.id);
            } else {
              S.notice(((r && r.error) || "标记失败"), true);
            }
          });
        });
      }
    });
  }
  function closeDrawer() {
    $("drawer-mask").hidden = true;
    $("job-drawer").hidden = true;
    fetchJobs(parseInt($("jobs-pager").getAttribute("data-page") || "1", 10));
  }

  // ================= 申请记录 =================
  function loadApplications(params) {
    var stage = (params && params.stage) || "all";
    $("a-stage").value = stage;
    $("funnel").innerHTML = '<div class="state">加载中…</div>';
    $("app-timeline").innerHTML = '<div class="state">加载中…</div>';
    S.stats(30).then(function (r) {
      if (r && r.ok) renderFunnel((r.data || r).totals);
      else $("funnel").innerHTML = '<div class="hint">本地模式：漏斗不可用</div>';
    });
    S.listApplications(stage === "all" ? {} : { stage: stage }).then(function (resp) {
      if (!(resp && resp.ok)) {
        $("app-timeline").innerHTML = '<div class="state">加载申请记录失败（' + esc((resp && resp.error) || "后端未连接") + "）</div>";
        return;
      }
      var items = (resp.data || resp).items || [];
      if (!items.length) {
        $("app-timeline").innerHTML = '<div class="state">还没有投递记录。在职位抽屉里点「标记投递」开始。</div>';
        return;
      }
      $("app-timeline").innerHTML = items.map(appCard).join("");
      bindAppEvents(items);
    });
  }
  function renderFunnel(t) {
    var steps = [
      { label: "已投递", n: t.applied },
      { label: "已读", n: t.read },
      { label: "面试", n: t.interview },
      { label: "Offer", n: t.offer },
    ];
    var max = Math.max(1, steps[0].n);
    $("funnel").innerHTML = steps.map(function (s, i) {
      var rate = i > 0 && steps[i - 1].n ? ((s.n / steps[i - 1].n) * 100).toFixed(0) + "%" : "";
      return '<div class="funnel-row"><span class="funnel-label">' + s.label + "</span>" +
        '<div class="funnel-bar" style="width:' + Math.max(2, (s.n / max) * 100) + '%"></div>' +
        '<span class="funnel-num">' + s.n + '</span><span class="funnel-rate">' + rate + "</span></div>";
    }).join("");
  }
  function appCard(a) {
    var u = S.safeUrl(a.url);
    var stages = ["applied", "read", "interview", "offer", "rejected"];
    var btns = stages.map(function (s) {
      var legal = canTransit(a.stage, s);
      var cls = s === a.stage ? "cur" : (legal ? "" : "illegal");
      return '<button class="stage-btn ' + cls + '" data-id="' + a.id + '" data-stage="' + s + '"' +
        (legal ? "" : " disabled") + ">" + STATUS_LABEL[s] + "</button>";
    }).join("");
    return '<div class="app-card" data-id="' + a.id + '">' +
      '<div class="app-head"><span class="app-title">' +
      (u ? '<a class="title-link" href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(a.title || "（无标题）") + "</a>" : esc(a.title || "（无标题）")) +
      "</span><span>" + pill(a.stage, 0) +
      (a.stalled_days >= 7 ? ' <span class="stall-badge" title="非终态申请超过 7 天无新动态">⏳ 停滞 ' + a.stalled_days + " 天</span>" : "") +
      ' <button class="btn ghost app-withdraw">撤回</button></span></div>' +
      '<div class="app-meta">' + esc(a.company || "") + " · 渠道：" + esc(a.channel || "其他") +
      " · 投递 " + esc(fmtTs(a.applied_at)) + " · 匹配度 " + num(a.match_score) + "</div>" +
      '<div class="stage-btns">' + btns + '<button class="btn ghost app-followup" data-job="' + a.job_id + '" title="写入一条备注事件并重置停滞时钟">📌 记录跟进</button></div></div>';
  }
  function bindAppEvents(items) {
    Array.prototype.forEach.call($("app-timeline").querySelectorAll(".stage-btn"), function (b) {
      b.addEventListener("click", function () {
        var id = parseInt(b.getAttribute("data-id"), 10);
        var to = b.getAttribute("data-stage");
        S.patchApplication(id, { stage: to }).then(function (r) {
          if (r && r.ok) {
            S.notice("阶段已更新为 " + STATUS_LABEL[to]);
            loadApplications({ stage: $("a-stage").value });
          } else {
            S.notice("流转被拒：" + ((r && r.error) || "非法流转"), true);
            loadApplications({ stage: $("a-stage").value });
          }
        });
      });
    });
    Array.prototype.forEach.call($("app-timeline").querySelectorAll(".app-followup"), function (b) {
      b.addEventListener("click", function () {
        var jobId = parseInt(b.getAttribute("data-job"), 10);
        var at = Date.now();
        S.postEvent({
          type: "note", job_id: jobId, at: at, dedup_key: "fu-" + jobId + "-" + at,
          payload: { note: "已跟进（管理页记录）" },
        }).then(function (r) {
          if (r && r.ok) {
            S.notice("已记录跟进，停滞时钟已重置");
            loadApplications({ stage: $("a-stage").value });
          } else {
            S.notice("记录失败：" + ((r && r.error) || ""), true);
          }
        });
      });
    });
    Array.prototype.forEach.call($("app-timeline").querySelectorAll(".app-withdraw"), function (b) {
      b.addEventListener("click", function () {
        var id = parseInt(b.closest(".app-card").getAttribute("data-id"), 10);
        S.deleteApplication(id).then(function (r) {
          if (r && r.ok) {
            S.notice("已撤回，职位回到「已查看」");
            loadApplications({ stage: $("a-stage").value });
          } else {
            S.notice("撤回失败：" + ((r && r.error) || ""), true);
          }
        });
      });
    });
  }

  // ================= 设置 =================
  function loadSettings() {
    S.storageGet(["bossassist_base"]).then(function (res) {
      $("s-base").value = res.bossassist_base || S.DEFAULT_BASE;
    });
    S.getSettings().then(function (resp) {
      if (!(resp && resp.ok)) {
        $("llm-info").textContent = "后端未连接，无法读取配置";
        return;
      }
      var d = resp.data || resp;
      $("s-name").value = d.user_name || "";
      var s = d.search || {};
      $("s-keywords").value = (s.keywords || []).join(", ");
      $("s-salary-min").value = s.salary_min !== undefined && s.salary_min !== null ? s.salary_min : "";
      $("s-roles").value = (s.target_roles || []).join(", ");
      $("s-skills").value = (s.skills_required || []).join(", ");
      // v3.7.0：技能词典（JD 关键词缺口对照用）
      $("s-dict").value = ((d.kv && d.kv.keywords) || []).join("\n");
      $("llm-info").textContent = "provider=" + (d.llm.provider || "—") +
        " · model=" + (d.llm.model || "—") +
        " · 已配置=" + (d.llm.configured ? "是" : "否") +
        " · 评分引擎=" + (d.scoring_engine || "—");
    });
    renderResumes();
  }
  function renderResumes() {
    S.listResumes().then(function (resp) {
      if (!(resp && resp.ok)) {
        $("resume-list").innerHTML = '<div class="hint">简历列表不可用</div>';
        return;
      }
      var items = (resp.data || resp).items || [];
      if (!items.length) {
        $("resume-list").innerHTML = '<div class="hint">还没有简历版本</div>';
        return;
      }
      $("resume-list").innerHTML = items.map(function (r) {
        return '<div class="resume-item"><b>' + esc(r.name) + "</b>" +
          (r.is_default ? '<span class="default-tag">默认</span>' : "") +
          '<button class="btn ghost r-view" data-id="' + r.id + '">预览</button>' +
          '<button class="btn ghost r-export" data-id="' + r.id + '" data-fmt="md">导出MD</button>' +
          '<button class="btn ghost r-export" data-id="' + r.id + '" data-fmt="html">打印版HTML</button>' +
          (r.is_default ? "" : '<button class="btn ghost r-default" data-id="' + r.id + '">设为默认</button>') +
          '<button class="btn ghost r-del" data-id="' + r.id + '">删除</button></div>';
      }).join("");
      Array.prototype.forEach.call($("resume-list").querySelectorAll(".r-export"), function (b) {
      b.addEventListener("click", function () {
        var id = parseInt(b.getAttribute("data-id"), 10);
        var fmt = b.getAttribute("data-fmt") || "md";
        S.exportResume(id, fmt).then(function (r) {
          if (r && r.ok) {
            var d = r.data !== undefined ? r.data : r;
            download("resume-" + id + (fmt === "html" ? ".html" : ".md"),
              typeof d === "string" ? d : JSON.stringify(d),
              fmt === "html" ? "text/html" : "text/markdown");
          } else {
            S.notice("导出失败：" + ((r && r.error) || ""), true);
          }
        });
      });
    });
    Array.prototype.forEach.call($("resume-list").querySelectorAll(".r-view"), function (b) {
        b.addEventListener("click", function () {
          S.getResume(parseInt(b.getAttribute("data-id"), 10)).then(function (r) {
            if (r && r.ok) {
              var d = r.data || r;
              var md = (d.resume || d).content_md || "";
              $("resume-preview").innerHTML = window.BOSSMD && BOSSMD.render ? BOSSMD.render(md) : esc(md);
            }
          });
        });
      });
      Array.prototype.forEach.call($("resume-list").querySelectorAll(".r-default"), function (b) {
        b.addEventListener("click", function () {
          S.patchResume(parseInt(b.getAttribute("data-id"), 10), { is_default: 1 }).then(function () {
            S.notice("已设为默认");
            renderResumes();
          });
        });
      });
      Array.prototype.forEach.call($("resume-list").querySelectorAll(".r-del"), function (b) {
        b.addEventListener("click", function () {
          S.deleteResume(parseInt(b.getAttribute("data-id"), 10)).then(function () {
            S.notice("已删除");
            renderResumes();
          });
        });
      });
    });
  }

  // ================= 事件绑定 =================
  function bindGlobal() {
    $("btn-sync").addEventListener("click", function () {
      S.flushOutbox().then(function (r) {
        S.notice(r.ok ? "同步完成，补传 " + (r.flushed || 0) + " 条" : "同步失败：" + (r.error || ""), !r.ok);
        return checkBackend();
      }).then(route);
    });

    // 职位筛选
    ["f-status", "f-sort", "f-fav"].forEach(function (id) {
      $(id).addEventListener("change", function () { fetchJobs(1); });
    });
    var qTimer = null;
    $("f-q").addEventListener("input", function () {
      clearTimeout(qTimer);
      qTimer = setTimeout(function () { fetchJobs(1); }, 350);
    });
    ["f-min-score", "f-max-score", "f-min-salary"].forEach(function (id) {
      $(id).addEventListener("change", function () { fetchJobs(1); });
    });
    $("check-all").addEventListener("change", function () {
      Array.prototype.forEach.call(document.querySelectorAll(".row-chk"), function (c) {
        c.checked = $("check-all").checked;
        c.closest("tr").classList.toggle("selected", c.checked);
      });
      updateBulkBar();
    });
    $("bulk-archive").addEventListener("click", function () {
      var ids = selectedIds();
      S.bulkJobs({ ids: ids, action: "status", value: "archived" }).then(function () {
        S.notice("批量归档完成（非法流转自动跳过）");
        fetchJobs(parseInt($("jobs-pager").getAttribute("data-page") || "1", 10));
      });
    });
    $("bulk-delete").addEventListener("click", function () {
      if (!confirm("确认删除选中职位？级联删除其事件与投递记录。")) return;
      S.bulkJobs({ ids: selectedIds(), action: "delete" }).then(function () {
        S.notice("批量删除完成");
        fetchJobs(parseInt($("jobs-pager").getAttribute("data-page") || "1", 10));
      });
    });
    $("btn-add-job").addEventListener("click", function () {
      var url = prompt("职位链接（可留空）：");
      if (url === null) return;
      var title = prompt("职位名称：");
      if (!title) return;
      S.createJob({ url: url, title: title }).then(function (r) {
        if (r && r.ok) {
          S.notice("已添加");
          fetchJobs(1);
        } else {
          S.notice("添加失败：" + ((r && r.error) || ""), true);
        }
      });
    });
    $("dw-close").addEventListener("click", closeDrawer);
    $("drawer-mask").addEventListener("click", closeDrawer);

    // 申请记录
    $("a-stage").addEventListener("change", function () {
      go("applications", { stage: $("a-stage").value });
    });
    $("btn-add-app").addEventListener("click", function () {
      var url = prompt("职位链接：");
      if (!url) return;
      var title = prompt("职位名称：") || "手动投递";
      S.createJob({ url: url, title: title }).then(function (r) {
        if (!(r && r.ok)) {
          S.notice("创建职位失败：" + ((r && r.error) || ""), true);
          return;
        }
        var d = r.data || r;
        return S.createApplication({ job_id: d.id, channel: "其他" }).then(function (r2) {
          if (r2 && r2.ok) {
            S.notice("已新增投递");
            loadApplications({ stage: "all" });
          } else {
            S.notice("新增投递失败：" + ((r2 && r2.error) || ""), true);
          }
        });
      });
    });

    // 设置
    $("s-test").addEventListener("click", function () {
      var base = $("s-base").value.trim();
      S.storageSet({ bossassist_base: base }).then(function () {
        return S.ping();
      }).then(function (r) {
        $("s-test-result").textContent = r.ok ? "✅ 连接成功" : "❌ " + (r.error || "连接失败");
        $("s-test-result").style.color = r.ok ? "#16a34a" : "#dc2626";
        setBackendState(!!r.ok);
      });
    });
    $("s-save-prefs").addEventListener("click", function () {
      var split = function (v) {
        return v.split(/[,，]/).map(function (x) { return x.trim(); }).filter(Boolean);
      };
      var body = {
        user_name: $("s-name").value.trim(),
        search: {
          keywords: split($("s-keywords").value),
          salary_min: $("s-salary-min").value.trim() ? Number($("s-salary-min").value.trim()) : null,
          target_roles: split($("s-roles").value),
          skills_required: split($("s-skills").value),
        },
      };
      S.putSettings(body).then(function (r) {
        S.notice(r.ok ? "偏好已保存（config.yaml 已备份 .bak）" : "保存失败：" + ((r && r.error) || ""), !(r && r.ok));
      });
    });
    $("s-dict-save").addEventListener("click", function () {
      // v3.7.0：技能词典存 settings.keywords（每行一个）
      var list = $("s-dict").value.split("\n").map(function (x) { return x.trim(); }).filter(Boolean);
      S.putSettings({ kv: { keywords: list } }).then(function (r) {
        $("s-dict-result").textContent = r.ok ? "✅ 词典已保存（" + list.length + " 项，与内置词典合并去重）" : "❌ " + ((r && r.error) || "保存失败");
        $("s-dict-result").style.color = r.ok ? "#16a34a" : "#dc2626";
      });
    });
    $("s-resume-save").addEventListener("click", function () {
      var file = $("s-resume-file").files[0];
      if (!file) {
        S.notice("请先选择 .md 文件", true);
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        S.saveResume({ name: $("s-resume-name").value.trim() || file.name.replace(/\.md$/i, ""), content_md: String(reader.result) })
          .then(function (r) {
            S.notice(r.ok ? "简历版本已保存" : "保存失败：" + ((r && r.error) || ""), !(r && r.ok));
            renderResumes();
          });
      };
      reader.readAsText(file, "utf-8");
    });

    // 数据
        $("btn-weekly").addEventListener("click", function () {
      S.weeklyReport().then(function (r) {
        if (!(r && r.ok)) {
          S.notice("周报生成失败：" + ((r && r.error) || "后端未连接"), true);
          return;
        }
        var d = r.data || r;
        var day = new Date();
        var p = function (n) { return (n < 10 ? "0" : "") + n; };
        download("求职周报-" + day.getFullYear() + p(day.getMonth() + 1) + p(day.getDate()) + ".md", d.md || "", "text/markdown");
        S.notice("周报已下载");
      });
    });
    $("btn-export-json").addEventListener("click", function () {
      S.exportData("json").then(function (r) {
        if (!(r && r.ok)) return S.notice("导出失败", true);
        download("jobtrack-export.json", JSON.stringify(r.data || r, null, 2), "application/json");
      });
    });
    $("btn-export-csv").addEventListener("click", function () {
      S.exportData("csv").then(function (r) {
        if (!(r && r.ok)) return S.notice("导出失败", true);
        var d = r.data !== undefined ? r.data : r;
        download("jobtrack-jobs.csv", typeof d === "string" ? d : JSON.stringify(d), "text/csv");
      });
    });
    $("btn-import").addEventListener("click", function () { $("import-file").click(); });
    $("import-file").addEventListener("change", function () {
      var file = $("import-file").files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var obj;
        try {
          obj = JSON.parse(String(reader.result));
        } catch (e) {
          S.notice("不是合法 JSON 文件", true);
          return;
        }
        // 旧版历史是数组 → 包一层 history
        S.importData(Array.isArray(obj) ? { history: obj } : obj).then(function (r) {
          if (r && r.ok) {
            var d = r.data || r;
            S.notice("导入完成：" + JSON.stringify({ jobs: d.jobs, imported: d.imported }));
            route();
          } else {
            S.notice("导入失败：" + ((r && r.error) || ""), true);
          }
        });
      };
      reader.readAsText(file, "utf-8");
      $("import-file").value = "";
    });
    $("btn-import-history").addEventListener("click", function () {
      // 从 chrome.storage 读旧版 bossassist_history 导入（不需要文件）
      S.storageGet(["bossassist_history"]).then(function (res) {
        var hist = res.bossassist_history || [];
        if (!hist.length) return S.notice("本地没有旧版历史", true);
        S.importData({ history: hist }).then(function (r) {
          if (r && r.ok) {
            S.notice("已导入本地旧版历史 " + hist.length + " 条");
            route();
          } else {
            S.notice("导入失败：" + ((r && r.error) || ""), true);
          }
        });
      });
    });
    $("btn-clear").addEventListener("click", function () {
      $("clear-confirm-row").hidden = !$("clear-confirm-row").hidden;
    });
    $("clear-confirm-btn").addEventListener("click", function () {
      if ($("clear-confirm-text").value.trim() !== "清空") {
        S.notice("请输入「清空」确认", true);
        return;
      }
      S.resetAll().then(function (r) {
        if (r && r.ok) {
          S.notice("数据已清空");
          $("clear-confirm-row").hidden = true;
          $("clear-confirm-text").value = "";
          route();
        } else {
          S.notice("清空失败：" + ((r && r.error) || ""), true);
        }
      });
    });
  }
  function selectedIds() {
    return Array.prototype.map.call(document.querySelectorAll(".row-chk:checked"), function (c) {
      return parseInt(c.getAttribute("data-id"), 10);
    });
  }
  function download(name, content, mime) {
    var blob = new Blob([content], { type: mime + ";charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  // ================= 启动 =================
  bindGlobal();
  // 开页先补传离线队列（T11），再路由
  S.flushOutbox().then(function (r) {
    if (r.ok && r.flushed) S.notice("已补传 " + r.flushed + " 条离线数据");
    return checkBackend();
  }).then(route);
})();
