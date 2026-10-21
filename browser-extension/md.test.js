// md.js 渲染器回归测试：node browser-extension/md.test.js
// 覆盖标题/列表/引用/代码/表格/链接 + XSS 注入拦截。
const BOSSMD = require("./md.js");
const sample = [
  "# 标题一", "## 综合评估", "**结论**：值得投 · 85/100", "",
  "- 依据：技能匹配", "- 命中：Python、LLM", "1. 第一", "2. 第二",
  "> 引用提示", "```", "code line", "```", "| a | b |", "|---|---|", "| 1 | 2 |",
  "---", "链接 [官网](https://example.com) *斜体* `code`",
  "XSS: <script>alert(1)</script> **[x](javascript:alert(1))**",
].join("\n");
const out = BOSSMD.render(sample);
for (const b of ["<script>", 'href="javascript:']) {
  if (out.includes(b)) { console.error("XSS LEAK: " + b); process.exit(1); }
}
const must = ["<h3>综合评估</h3>", "<table>", "<ul>", "<ol>", "<blockquote>", "<pre><code>", "<strong>"];
for (const m of must) {
  if (!out.includes(m)) { console.error("STRUCTURE MISSING: " + m); process.exit(1); }
}
console.log("md.js render test PASSED");
