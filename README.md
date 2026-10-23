# Boss 求职辅助

在 **Boss 直聘职位详情页就地分析** 的求职辅助工具：浏览器扩展（注入式，非抓取）+ 本地 Python 后端。

使用路径：
**启动后端 → 你用日常浏览器打开 Boss 并登录（插件自行加载）→ 搜索职位、点开详情页 → 点插件图标 → 页面右侧滑出常驻侧边栏 → 后端分析/评估/优化简历/生成话术 → 侧边栏就地展示。**

> 设计要点：代码**不操作浏览器**，扩展由你自行加载与管理；扩展**就地读取当前页 DOM**，不重新导航、不抓取列表、不触发反爬；LLM key 只留在本机后端，不进浏览器。

![Boss 求职辅助 · 主视觉](assets/hero.png)

## 🧭 架构

```
python launch.py（只启动后端）
   └─ 本地 FastAPI 后端（web/app.py，/ext 分析 API，127.0.0.1:8000）

浏览器扩展(browser-extension/)       后台代理 POST         本地后端(本项目)
┌──────────────────────────┐      ─── /ext/* ────►         ┌──────────────────────────┐
│ 点图标 → 右侧常驻侧边栏    │                             │ web/app.py（FastAPI）     │
│ content_script 就地读当前页│                             │  GET  /ext/ping  连通性   │
│ （不导航、不抓取）         │                             │  POST /ext/assess 匹配+薪资│
│ 结果可一键复制/收藏        │  ◄── JSON ──────────────── │  POST /ext/pack  一键分析  │
└──────────────────────────┘                             │  POST /ext/summary 岗位速览│
                                                          │  POST /ext/interview 面试预测│
                                                          │  POST /ext/optimize 简历优化│
                                                          │  POST /ext/greeting 打招呼语│
                                                          │  POST /ext/analysis 深度分析│
                                                          │  POST /ext/plan 准备计划    │
                                                          │  POST /ext/company 公司情报│
                                                          │  POST /ext/salary-talk 谈薪│
                                                          │  POST /ext/self-intro 自介 │
                                                          │  POST /ext/star 项目讲稿   │
                                                          │  POST /ext/chat-tone HR话术 │
                                                          │ LLM Key 留在后端            │
                                                          └──────────────────────────┘
```

## 🚀 快速开始

```bash
pip install -r requirements.txt
cp config.yaml.example config.yaml    # 填写 search 偏好 / llm 配置
```

### 1. 启动后端

```bash
python launch.py
```

- 启动 8000 端口后端（仅监听 127.0.0.1），并自检 LLM 配置是否就绪。
- 退出按 `Ctrl+C`。开发热重载：`python launch.py --reload`。

### 2. 自行加载扩展（用户自定义，一次性）

- Firefox：`about:debugging#/runtime/this-firefox` →「临时载入附加组件」→ 选 `browser-extension/manifest.json`。
- Chrome：`chrome://extensions` → 开发者模式 →「加载已解压的扩展程序」→ 选 `browser-extension/` 目录。
- 用你自己的浏览器环境打开 Boss 直聘并登录（浏览器指纹/风控由你自己的浏览器负责）。
- **更新插件**（每次改代码后）：`chrome://extensions` 点扩展卡片「🔄 刷新」→ 职位页 **F5** → 面板底部版本角标显示 `· v3.8.0` 即生效。MV3 的 content script 不热更新，旧标签页必须刷新，角标没变就是旧代码。

### 3. 使用

Boss 职位详情页 → 点工具栏「Boss 求职辅助」图标 → **右侧滑出常驻侧边栏**（切 tab、点页面都不会消失；翻页后自动恢复）→ 点按钮就地分析。

> 详细用法见 [`browser-extension/README.md`](browser-extension/README.md)。

## ✨ 功能

侧边栏（`browser-extension/content_script.js`）在职位详情页提供：

| 功能 | 说明 |
|------|------|
| ✅ **提取 → 确认 → 分析** | 职位自动提取后可核对/修改（表单可编辑），点「✅ 确认，启用分析」后才开始分析，分析使用确认后的内容 |
| ↻ **重新加载** | 职位卡一键重新提取当页职位信息（切职位/改 JD 后不用关面板） |
| 🛡 **反乱码提取** | 自动识别站点字体反爬乱码，从页面内嵌数据还原职位名/薪资/公司真值；仍乱码时提示手改（v3.4.1） |
| 🗂 **卡片折叠** | 点任意卡片标题（▾/▸）折叠展开，不遮挡结果；折叠状态本地记忆 |
| ⚙ **模块管理** | 不需要的功能/卡片可关掉（13 个功能按钮 + 5 个卡片独立开关），配置本地记忆 |
| ⚡ **一键分析** | 评估 + 深度分析 + 岗位速览 + 打招呼 + 面试预测，一次返回 |
| 🔍 **评估职位** | 匹配度（后端 LLM 评分，`engine` 字段标注，失败自动回退规则）+ 薪资合理性 + 深度分析 |
| 📊 **深度分析** | 岗位画像 / 人岗匹配点 / 简历差距 / 风险红旗 / 行动建议（固定小节，融合上传简历） |
| 🗺 **准备计划** | 7 天准备清单 / 高频面试题 / 项目经历包装 / 反问建议（融合上传简历） |
| 🏢 **公司情报** | 公司与业务 / 团队与岗位定位 / 风险红旗 / 面经与考察重点（常识 + JD 推断，不确定标「待核实」） |
| 💰 **谈薪策略** | 薪资区间判断 / 开价策略 / 压价应对话术（3 场景）/ 谈判时机与红线 |
| 🎤 **自我介绍** | 30 秒 / 1 分钟 / 3 分钟三档讲稿（只用简历真实经历） |
| ⭐ **项目讲稿** | 简历项目 STAR 包装（情境/任务/行动/结果）+ 深挖防线，量化沿用简历原值 |
| 📋 **岗位速览** | JD 太长时压缩成 职责/要求/亮点 三要点 |
| 🎯 **面试预测** | 基于 JD + 简历预测面试考察点/大概率问题（含简历深挖） |
| 📄 **简历优化** | 按当前 JD 重写简历 + 事实保护（不许改学历/年限/数字），固定 Markdown 简历结构 |
| 📄 **上传 Markdown 简历** | 侧边栏「加载 .md」上传本地简历，评估/一键分析/简历优化自动参考（未上传时用 `data/base_resume.md`） |
| 🎨 **Markdown 富文本渲染** | 结果区标题/列表/引用/代码/表格美化渲染（`md.js`，XSS 安全），复制取纯文本 |
| 💬 **打招呼语** | 生成个性化打招呼 |
| 🧠 **HR 话术** | 粘贴 HR 消息 → 多语气回复候选 |
| 📋 **复制结果** | 一键复制到剪贴板 |
| ⭐ **收藏 / 🕘 历史** | 本地保存分析结果，随时回看 |
| 🗂 **管理页（v3.5.0）** | 独立标签页管理中枢：概览统计 / 职位管理 / 申请记录 / 设置，数据落本地 SQLite（`data/jobtrack.db`），详见 [扩展说明](browser-extension/README.md) |
| ☁ **数据同步（v3.5.0）** | 浏览/分析/收藏事件静默同步到管理页；离线排队（≤500 条）自动补传、绝不弹错；「模块管理」可关 |
| 📌 **求职行动闭环（v3.6.0）** | 跟进提醒（停滞 ≥7 天申请自动浮出 +「📌 记录跟进」重置时钟）/ 求职周报（近 7 天 Markdown 复盘一键导出）/ 简历导出（Markdown + 打印版 HTML）；**本次未改 `/ext` 接口，不抓取站点数据、不自动投递** |
| 🧩 **JD 关键词缺口 + 💰 薪酬对比（v3.7.0）** | 零 token 本地规则：JD 与简历对照出「⚠️ 简历缺口 / ✅ 已覆盖 / 💡 简历亮点」，词典内置 ~75 词 + 设置页可编辑；概览新增薪酬区间横向条形对比（解析 `15k-25k`/`14薪`/`1-2万`，面议剔除）；**未改 `/ext`，不抓取、不自动投递** |
| 🎨 **现代简约 UI 重构（v3.8.0）** | 管理页与侧边栏统一一套 Design Token（白底 / 圆角 12px / 双层柔和阴影 / 微交互）；概览卡加图标 + 强调色、卡片 hover 上浮；侧边栏 13 个功能按钮按「一键&评估 / 深度分析 / 求职动作」分组可折叠（折叠状态本地记忆，独立于模块开关）；趋势与评分分布图加网格线 + Y 轴刻度 + 悬停 tooltip；**纯视觉重构，不改动 `/ext` 接口与业务逻辑** |
| ⚙ **设置后端地址** | 默认 `http://127.0.0.1:8000` |

## 🖼 案例展示

> 以下为产品概念示意插图（非真实界面截图，用于快速理解能力边界）。

| 🔍 职位评估 | 📄 简历优化 | 🎯 面试预测 |
| --- | --- | --- |
| ![职位评估 · 匹配度评分与风险提示](assets/case-assess.png) | ![简历优化 · 按 JD 重写并保护事实](assets/case-optimize.png) | ![面试预测 · 考察点与高频题](assets/case-interview.png) |

## 📁 目录

```
launch.py                    一键启动后端（不操作浏览器）
web/app.py                   FastAPI 入口（/info、/health + 挂载 /ext）
web/ext_api.py               浏览器扩展后端路由（/ext/*）
web/db.py                    管理页 SQLite 数据底座（五表 + 状态机 + 事件去重，v3.5.0）
web/admin_api.py             管理页 REST API（/api/*：统计/职位/申请/事件/设置/导入导出/周报/简历导出/关键词缺口/薪酬对比，v3.7.0）
web/__main__.py              python -m web 启动
tools/config.py              配置加载 + 默认值
tools/llm_client.py          多 provider LLM 客户端（retry / JSON 解析）
tools/scoring.py             本地规则评分（score_local，LLM 评分失败时兜底）
tools/salary_utils.py        薪资解析 / 达标判断 / 质量分
tools/keyword_utils.py       关键词缺口零 token 规则引擎（内置词典 + 自定义，v3.7.0）
tools/resume_parser.py       简历事实抽取 + 完整性保护 + 导出
data/base_resume.md          基础简历文件（插件未上传简历时简历优化读取，可选）
data/jobtrack.db             管理页本地数据库（自动生成，已 .gitignore，v3.5.0）
config.yaml                  用户偏好 + LLM 配置
browser-extension/           浏览器扩展（MV3，右侧常驻侧边栏 + 🗂 管理页，用户自行加载）
```

## ⚙️ 关键配置（config.yaml）

- **求职偏好**：`search.keywords`、`salary_min`（元/月）、`target_roles`、`skills_required` / `skills_bonus` / `boost_keywords` / `exclude_keywords`
- **评分**：`scoring.engine` = `llm`（默认，后端 LLM 评分，失败自动回退规则）| `hybrid` | `local`（0 token 纯规则）
- **LLM**：`llm.provider` = `claude` / `openai` / `openai_compatible` / `ollama`；key 可内联 `llm.api_key`（优先）或走 `llm.api_key_env` 环境变量
- **基础简历**：`user.base_resume_path` 指向 Markdown 简历（`data/base_resume.md`）

> 🔐 `config.yaml` 含 LLM key，**已在 `.gitignore` 中忽略，不入库**；公开仓库只提交 `config.yaml.example` 模板。`__pycache__`、`data/`、`_smoke_*` 验证脚本同样忽略。

## 🔗 推荐中转站（AFF 推广链接）

> 以下为 **AFF 推广链接**（整理自导航站 [领航舱 · 020417.xyz](https://020417.xyz/) 的「AFF」类目）：通过链接注册我获得少量返利，价格与你直接注册一致。不需要推广可直接删除本节。

| 服务 | 说明 | 链接 |
| --- | --- | --- |
| bigme 节点中转站 | 一个节点，注册即用 | [注册](https://1s.bigmeok.me/user#/register?code=ZTrIUOBr) |
| 小肩膀token | AI中转站 | [注册](https://www.fastaitoken.com/register?aff=WE5KN7HXYFA5) |
| 猿人学token | AI中转站 | [注册](https://xfastapi.ai/register?aff=C95CW43PDZLC) |
| 一坨屎token | AI中转站 | [注册](https://yituoshiai.com/sign-up?aff=qKbX) |
| colocrossing VPS | 11 刀/年 VPS，可自建中转 | [购买](https://cloud.colocrossing.com/aff.php?aff=1191&pid=95) |
| 硅基流动Token | Ai中转站,注册免费送14元 | [注册](https://cloud.siliconflow.cn/i/YPTRToh2) |

> 还有更多可以去网站看

## 🛡️ 提醒

本项目仅用于**个人求职自用**。扩展为手动触发、就地分析，**不发起抓取请求/不抓取列表**。请遵守 Boss 直聘服务条款