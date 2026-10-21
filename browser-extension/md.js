// BOSSMD —— 轻量 Markdown 渲染器（供侧边栏结果区使用）
// 无外部依赖；所有文本先 HTML 转义再插入，杜绝 XSS。
// 支持：标题/粗体/斜体/行内代码/链接/列表(ul,ol)/引用/围栏代码/表格/分隔线/段落换行。
var BOSSMD = (function () {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // 行内语法（输入已转义）
  function inline(s) {
    let out = esc(s);
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    return out;
  }

  function isTableRow(l) {
    return l.includes("|") && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.includes("-");
  }

  function render(md) {
    const lines = String(md == null ? "" : md).replace(/\r\n?/g, "\n").split("\n");
    const html = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // 围栏代码块
      const fence = line.match(/^\s*```/);
      if (fence) {
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(esc(lines[i++]));
        i++; // 跳过收尾 ```
        html.push("<pre><code>" + buf.join("\n") + "</code></pre>");
        continue;
      }

      // 空行
      if (!line.trim()) { i++; continue; }

      // 标题
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const lv = Math.min(h[1].length + 1, 6); // h1 降为 h2，避免过大
        html.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
        i++;
        continue;
      }

      // 分隔线
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        html.push("<hr>");
        i++;
        continue;
      }

      // 引用块（连续 > 行）
      if (/^\s*>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i]))
          buf.push(inline(lines[i++].replace(/^\s*>\s?/, "")));
        html.push("<blockquote>" + buf.join("<br>") + "</blockquote>");
        continue;
      }

      // 表格：当前行含 | 且下一行是分隔行
      if (line.includes("|") && i + 1 < lines.length && isTableRow(lines[i + 1])) {
        const cells = (l) => l.replace(/^\s*\||\|\s*$/g, "").split("|").map((c) => c.trim());
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim())
          rows.push(cells(lines[i++]));
        const th = head.map((c) => `<th>${inline(c)}</th>`).join("");
        const tr = rows.map((r) =>
          "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>").join("");
        html.push(`<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`);
        continue;
      }

      // 无序列表
      if (/^\s*[-*+]\s+/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]))
          buf.push(`<li>${inline(lines[i++].replace(/^\s*[-*+]\s+/, ""))}</li>`);
        html.push("<ul>" + buf.join("") + "</ul>");
        continue;
      }

      // 有序列表
      if (/^\s*\d+[.)]\s+/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]))
          buf.push(`<li>${inline(lines[i++].replace(/^\s*\d+[.)]\s+/, ""))}</li>`);
        html.push("<ol>" + buf.join("") + "</ol>");
        continue;
      }

      // 段落（连续非空行，行内换行 <br>）
      const buf = [];
      while (i < lines.length && lines[i].trim() &&
             !/^\s*(#{1,6}\s|>|[-*+]\s|\d+[.)]\s|```)/.test(lines[i]))
        buf.push(inline(lines[i++]));
      html.push("<p>" + buf.join("<br>") + "</p>");
    }

    return html.join("\n");
  }

  return { render: render, esc: esc };
})();

// Node 环境导出（浏览器里挂在全局，不影响 content script）
if (typeof module !== "undefined" && module.exports) module.exports = BOSSMD;
