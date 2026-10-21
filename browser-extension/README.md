# Boss 求职辅助 · 浏览器扩展（注入式，非抓取）

在 **Boss 直聘职位详情页就地分析** 的浏览器扩展（Chrome / Firefox，MV3）+ 本地后端。

设计目标：不重新导航、不触发反爬。自己搜索→点开职位详情→**点插件图标**，页面右侧滑出**常驻侧边栏**，读取**当前页** DOM，交给本地 FastAPI 做匹配度评分、岗位速览、面试预测、简历优化与沟通话术。

## 架构

```
浏览器扩展(browser-extension/)                 本地后端(本项目)
┌────────────────────────────┐        POST         ┌─────────────────────────────┐
│ 点图标 → 右侧常驻侧边栏      │                    │ web/app.py（FastAPI）        │
│ content_script 就地读当前页  │  ─── /ext/* ────►   │  ├ GET  /ext/ping  连通性     │
│ （不导航、不抓取）           │  经 background 代理  │  ├ POST /ext/assess 匹配+薪资 │
│ 结果可一键复制/收藏          │  ◄── JSON ───────  │  ├ POST /ext/pack  一键分析   │
└────────────────────────────┘                    │  ├ POST /ext/summary 岗位速览 │
                                                   │  ├ POST /ext/interview 面试预测│
                                                   │  ├ POST /ext/optimize 简历优化 │
                                                   │  ├ POST /ext/greeting 打招呼语 │
                                                   │  ├ POST /ext/chat-tone HR 话术 │
                                                   │ LLM Key 留在后端，不进浏览器  │
                                                   └─────────────────────────────┘
```

**侧边栏为什么常驻？** 面板是 content script 注入到页面里的（Shadow DOM 隔离），不是 popup。popup 一点别处就消失，侧边栏不会：切 tab、点页面、翻页都不会自动收起；刷新/翻页后如果上次是打开状态会自动恢复。点图标可开关，或点侧边栏右上角 ✕ 收起。

## 启动后端

```bash
python launch.py          # 默认 http://127.0.0.1:8000
```

代码**不操作浏览器**，浏览器与插件由你自己管理。依赖见 `requirements.txt`。LLM api_key 写在 `config.yaml` 的 `llm.api_key`（优先）或用 `llm.api_key_env` 指向环境变量，**key 只在后端**。

## 安装扩展（用户自行加载）

**Chrome（推荐）**：
1. 地址栏打开 `chrome://extensions`。
2. 右上角打开「开发者模式」。
3. 点「加载已解压的扩展程序」→ 选择本目录（`browser-extension/`，**选文件夹，不是选 manifest.json**）。

> 若之前装过旧版（MV2）：先在 `chrome://extensions` 把旧的删掉/移除，再重新加载，避免新旧并存。

**Firefox**（121+，同样支持 MV3）：打开 `about:debugging#/runtime/this-firefox` →「临时载入附加组件」→ 选本目录 `manifest.json`。

## 使用

1. 用你自己的浏览器登录 www.zhipin.com，搜索职位，**点开一个职位详情页**。
2. 点工具栏「Boss 求职辅助」图标 → 右侧滑出常驻侧边栏。
3. 侧边栏自动**提取**当前详情页职位信息，填入可编辑表单（职位/公司/薪资/地点/标签/JD）。部分站点用**字体反爬**（薪资/职位名显示乱码）：插件自动检测乱码并从页面内嵌数据还原真值，仍乱码时提示条会提醒重点核对，可直接手改（v3.4.1）。
4. **核对提取结果，有误直接修改** → 点「✅ 确认，启用分析」→ 功能按钮出现。
5. 点按钮（分析一律使用**确认后的表单内容**，修改后直接再点按钮即生效）：
   - **⚡ 一键分析**：评估 + 深度分析 + 岗位速览 + 打招呼 + 面试预测，一次返回（推荐）。
   - **🔍 评估职位**：匹配度评分（后端 LLM，`engine` 字段标注，失败回退规则）+ 薪资合理性 + 深度分析。
   - **📊 深度分析**：岗位画像 / 人岗匹配点 / 简历差距 / 风险红旗 / 行动建议（固定 5 小节，融合上传简历）。
   - **🗺 准备计划**：7 天准备清单 / 高频面试题 / 项目经历包装 / 反问建议（固定 4 小节，融合上传简历）。
   - **🏢 公司情报**：公司与业务 / 团队与岗位定位 / 风险红旗 / 面经与考察重点（常识 + JD 推断，不确定处标「待核实」，不编造融资/人数数字）。
   - **💰 谈薪策略**：薪资区间判断 / 开价策略 / 压价应对话术（3 场景）/ 谈判时机与红线。
   - **🎤 自我介绍**：30 秒 / 1 分钟 / 3 分钟三档讲稿（只用简历真实经历）。
   - **⭐ 项目讲稿**：简历项目 STAR 包装（情境/任务/行动/结果）+ 深挖防线，量化沿用简历原值（融合上传简历）。
   - **📋 岗位速览**：JD 太长时的 3 条要点速览（职责/要求/亮点）。
   - **🎯 面试预测**：基于 JD + 简历预测面试考察点/大概率问题（含简历深挖）。
   - **📄 简历优化**：按当前 JD 重写简历（优先用上传的 Markdown 简历，其次 `data/base_resume.md`，再次配置基础简历）。
   - **💬 打招呼语**：生成 2 条个性化打招呼（引用简历契合点）。
   - **🧠 HR 话术**：粘贴 HR 最新消息，给 3 种语气回复候选。

## 📄 我的简历（Markdown 上传）

侧边栏顶部「📄 我的简历」卡片支持**加载本地 `.md` 简历**：

- 点「加载 .md」选文件 → 简历正文存 `chrome.storage.local`（`bossassist_resume_md`），状态条显示已加载文件名/大小。
- **评估 / 一键分析 / 简历优化 / HR 话术**请求自动携带 `base_resume` 字段，评分和简历生成都会参考你的简历。
- 「查看」展开/收起简历预览，「清除」删除本地简历。
- 未上传时，简历优化退化读取后端 `data/base_resume.md`。

## 🎨 结果渲染

结果区为 **Markdown 富文本渲染**（`md.js` 渲染器，随 content script 注入）：标题、列表、引用、代码块、表格、链接均美化展示；全部文本先转义再渲染（防 XSS），链接仅放行 http/https。「📋 复制」复制渲染后的纯文本，可直接粘贴进 HR 聊天框。

## 便捷功能

- **📋 复制**：一键把当前结果复制到剪贴板。
- **⭐ 收藏 / 🕘 历史**：收藏的职位分析存到扩展本地存储（`chrome.storage.local`），随时点击回看，可删除。
- **⚙ 设置**：可修改后端地址（默认 `http://127.0.0.1:8000`）。
- **↻ 刷新 / ↻ 重新加载**：面板顶部「↻ 刷新」或职位卡「↻ 重新加载」重读当前页职位信息（切职位不用关面板）。
- **🗂 卡片折叠**：点任意卡片标题（▾/▸）折叠/展开该卡片；**点功能按钮出结果时，职位信息/我的简历/功能三张卡自动折叠、结果卡自动展开并滚动到位**，结果永远在眼前；折叠状态存 `bossassist_folded`。
- **⚙ 模块管理**：功能区标题栏「⚙ 模块管理」→ 勾选开关，关掉不需要的功能按钮/卡片（如不用谈薪就关「谈薪策略」）；配置存 `bossassist_modules`，随时可恢复。
- **✕ 收起**：点侧边栏右上角关闭；再点工具栏图标重新打开。

> 底部后端状态点显示连接情况。若提示「后端未连接」，先起后端（`python launch.py`）；若读不到职位，刷新一下详情页。

## 🔄 更新插件（重要）

改代码后 MV3 content script **不会热更新**，必须两步走：

1. `chrome://extensions` → 扩展卡片「🔄 刷新」
2. 职位页 **F5**（旧标签页跑的还是旧脚本）

核对面板底部**版本角标**（当前 `· v3.4.1`）——角标没变就是没更新成功，别当新 bug 报。

## 端点一览

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/ext/ping` | GET | 连通性 + 配置概要 |
| `/ext/assess` | POST | `JobPage` → 匹配分/薪资判断/深度分析 `analysis_md` |
| `/ext/analysis` | POST | `JobPage` → 深度人岗匹配分析（固定 5 小节 Markdown） |
| `/ext/plan` | POST | `JobPage` → 面试准备计划（固定 4 小节 Markdown） |
| `/ext/company` | POST | `JobPage` → 公司情报（固定 4 小节，常识 + JD 推断） |
| `/ext/salary-talk` | POST | `JobPage + search` → 谈薪策略（固定 4 小节） |
| `/ext/self-intro` | POST | `JobPage + base_resume` → 自我介绍三档（固定 3 小节） |
| `/ext/star` | POST | `JobPage + base_resume` → STAR 项目讲稿 + 深挖防线 |
| `/ext/pack` | POST | `JobPage` → 评估+深度分析+速览+打招呼+面试预测（一键） |
| `/ext/summary` | POST | `JobPage` → 岗位速览 |
| `/ext/interview` | POST | `JobPage` → 面试考察点预测（含简历深挖） |
| `/ext/optimize` | POST | `JobPage + base_resume/focus` → 优化后 Markdown + 完整性核对 |
| `/ext/greeting` | POST | 打招呼语 |
| `/ext/chat-tone` | POST | `JobPage + message` → HR 回复话术 |

后端 LLM prompt 统一锁输出格式（长文端点固定 Markdown 小节名、每条要点 ≤40 字；评分端点纯 JSON；列表端点每行一条），前端 `md.js` 按小节逐节渲染，分析类全部融合 `base_resume`。

`JobPage` 字段：`title/company/location/salary_range/jd_text/url/job_tags/interviewer/base_resume`（`base_resume` 为上传的 Markdown 简历，可选）。

## 文件说明

| 文件 | 职责 |
| --- | --- |
| `manifest.json` | MV3 清单（Chrome 111+ / Firefox 121+；无 default_popup） |
| `background.js` | MV3 service worker：点图标切换侧边栏；代理 `/ext/*` 请求（绕页面 CORS） |
| `md.js` | Markdown 渲染器（`BOSSMD.render`，XSS 安全；先于 content_script 注入） |
| `content_script.js` | 右侧常驻侧边栏（Shadow DOM）+ 就地读页 + 提取/确认表单 + 简历上传 + 各功能按钮 |
| `md.test.js` | md.js 渲染回归测试（`node browser-extension/md.test.js`，含 XSS 拦截断言） |
| `icons/` | 工具栏/扩展图标 |

页面 DOM 选择器集中在 `content_script.js` 的 `extractJob()`，站点改版后在此维护。

## 复用的既有逻辑（tools/）

- 评分：后端 `score_match`（`scoring.engine=llm` 时走 LLM JSON 评分，失败自动回退 `score_local` 规则通道）
- 薪资校验：`tools/salary_utils.py`（15k-25k / 1-2万 / 面议 解析 + 达标判断 + 质量分）
- 简历完整性保护：`tools/resume_parser.py::validate_resume_integrity`
- 配置：`config.yaml`（`user`/`search`/`scoring`/`llm`）
