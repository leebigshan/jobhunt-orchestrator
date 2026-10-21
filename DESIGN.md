# Boss 求职辅助 设计文档

一个专为 **Boss 直聘详情页就地辅助求职** 的工具：浏览器扩展（注入式、非抓取）+ 本地 Python 后端。
技术栈：**Python 3.11+ / FastAPI / uvicorn / httpx**（后端）+ **浏览器扩展 MV3**（用户自行加载）。

> 原「求职全链路自动化 Agent」（LangGraph 采集→筛选→投递→代聊 CLI）已按需求移除。本项目聚焦主动式、人工确认的求职辅助：**人在浏览器里自己看岗位，点插件让 AI 帮分析。**

## 一、核心使用流程

```
启动后端(launch.py，仅启动 FastAPI，不操作浏览器)
   └─ 本地 FastAPI 后端（web/app.py）
        ↓ 用户：用自己的浏览器打开 Boss 并登录（扩展自行加载，一次性）
        ↓ 用户：搜索职位 → 点开一个详情页 → 点插件图标
页面右侧滑出常驻侧边栏（Shadow DOM 注入，切 tab/翻页不消失）
插件 content_script 就地读取当前页 DOM（不导航、不抓取）
   ──POST /ext/*──► 后端分析（评分/薪资/速览/面试预测/简历优化/话术）
   ◄── JSON ── 侧边栏就地渲染结果，支持一键复制/收藏
```

## 二、模块职责

| 模块 | 职责 |
|------|------|
| `launch.py` | 一键启动后端（不操作浏览器；浏览器/扩展由用户自管） |
| `web/app.py` | FastAPI 入口，挂载 /ext 路由，/info、/health |
| `web/ext_api.py` | 浏览器扩展后端路由（7 个 /ext 端点） |
| `tools/config.py` | 读取 config.yaml + 默认值深度合并 |
| `tools/llm_client.py` | 多 provider（claude/openai/openai_compatible/ollama）LLM 客户端：retry/JSON 解析 |
| `tools/scoring.py` | 本地规则评分 `score_local`（0 token，LLM 评分失败兜底） |
| `tools/salary_utils.py` | 薪资解析（15k/1-2万/面议）/ 达标判断 / 质量分 |
| `tools/resume_parser.py` | 简历事实抽取 + 完整性保护（LLM 不得改学历/年限/数字）+ 导出 |
| `browser-extension/` | 浏览器扩展（MV3，Chrome/Firefox）：content_script（右侧常驻侧边栏 + 读当前页）/ background service worker（图标切换 + /ext 转发） |

## 三、/ext 端点

| 端点 | 请求体 | 处理 | 缺失 LLM 时 |
|------|--------|------|------|
| `GET /ext/ping` | — | 连通性 + 配置概要 | — |
| `POST /ext/assess` | `JobPage`（可带 `base_resume`） | 匹配分（`score_match`：LLM JSON 评分，`engine` 标注来源；失败回退 `score_local`）+ 薪资合理性 + 深度分析 `analysis_md`（并行） | 回退规则评分，`analysis_md` 提示不可用 |
| `POST /ext/analysis` | `JobPage`（可带 `base_resume`） | 深度人岗匹配分析 `analysis_md`（岗位画像/匹配点/差距/风险/行动建议 5 固定小节） | 提示不可用 |
| `POST /ext/plan` | `JobPage`（可带 `base_resume`） | 面试准备计划 `plan_md`（7 天清单/高频题/项目包装/反问建议 4 固定小节） | 提示不可用 |
| `POST /ext/company` | `JobPage` | 公司情报 `company_md`（公司业务/岗位定位/风险红旗/面经重点 4 固定小节；常识 + JD 推断，不确定标「待核实」） | 提示不可用 |
| `POST /ext/salary-talk` | `JobPage+search` | 谈薪策略 `salary_md`（区间判断/开价/压价应对 3 场景/时机红线 4 固定小节） | 提示不可用 |
| `POST /ext/self-intro` | `JobPage`（可带 `base_resume`） | 自我介绍 `intro_md`（30 秒/1 分钟/3 分钟 3 固定小节，只用简历真实经历） | 提示不可用 |
| `POST /ext/star` | `JobPage`（可带 `base_resume`） | STAR 项目讲稿 `star_md`（简历项目 S/T/A/R + 深挖防线，量化沿用简历原值） | 提示不可用 |
| `POST /ext/pack` | `JobPage`（可带 `base_resume`） | 一键：评估 + 深度分析 + 速览 + 打招呼 + 面试预测 | 评估回退规则，其余为空 |
| `POST /ext/summary` | `JobPage` | 3 条要点速览 | 返回空 |
| `POST /ext/interview` | `JobPage`（可带 `base_resume`） | 面试考察点预测（含简历深挖问题） | 返回空 |
| `POST /ext/optimize` | `JobPage+base_resume/focus` | 简历优化 + 完整性保护（`base_resume` 来源：插件上传 → `data/base_resume.md` → 占位） | 退回基础简历 |
| `POST /ext/greeting` | `JobPage`（可带 `base_resume`） | 打招呼语（引用简历契合点） | 返回空 |
| `POST /ext/chat-tone` | `JobPage+message` | HR 回复话术（专业/亲和/简洁三行） | 返回空 |

`JobPage`：`title/company/location/salary_range/jd_text/url/job_tags/interviewer`。

**Prompt 设计约定**（`web/ext_api.py`）：所有 LLM 端点锁死输出格式——长文端点走 `MD_FORMAT` 契约（纯 Markdown、固定小节名、每节 3-5 条要点、每条 ≤40 字、禁 HTML/全文代码围栏/套话），评分端点走 `SCORE_JSON_FORMAT`（纯 JSON），列表端点走「每行一条」契约；分析类 prompt 通过 `_resume_hint` 融合 `base_resume`（评分 3000 字、分析 4000 字），前端 `md.js` 按固定小节逐节渲染。

## 四、插件特色（浏览器扩展新增能力）

- **右侧常驻侧边栏**：点图标在页面右侧滑出面板（Shadow DOM 与页面隔离），切 tab / 点页面 / 翻页不消失，翻页后自动恢复；点图标或 ✕ 收起。
- **就地分析**：content script 读当前页，不重新导航，规避反爬。
- **提取 → 核对/修改 → 确认 → 分析**：职位信息自动提取后进可编辑表单（标题/公司/薪资/地点/标签/JD），用户核对修改并点「✅ 确认，启用分析」后才显示功能按钮；分析一律使用确认后的表单内容。
- **一键分析（/ext/pack）**：一次点击拿全部结论（评估 + 深度分析 + 速览 + 打招呼 + 面试预测）。
- **深度分析 / 准备计划**（/ext/analysis、/ext/plan）：岗位画像/匹配点/差距/风险/行动建议 + 7 天面试准备清单，固定 Markdown 小节结构化输出。
- **公司情报 / 谈薪策略 / 自我介绍 / 项目讲稿**（/ext/company、/ext/salary-talk、/ext/self-intro、/ext/star）：面试全流程四件套，全部走后端 LLM + 固定 Markdown 小节。
- **↻ 重新加载 + 卡片折叠 + 模块管理**：职位卡一键重提取当页；点卡片标题折叠/展开不遮结果（状态存 `bossassist_folded`）；「⚙ 模块管理」裁剪不需要的功能按钮/卡片（配置存 `bossassist_modules`）。
- **Markdown 简历上传**：侧边栏「加载 .md」把本地简历存 `chrome.storage.local`，随 `base_resume` 随请求送后端。
- **Markdown 富文本渲染**：结果区经 `md.js` 渲染（标题/列表/引用/代码/表格），XSS 全量转义；复制取渲染纯文本。
- **复制 / 收藏**：结果一键复制到剪贴板；收藏存扩展本地存储（`chrome.storage.local`），可回看/删除。
- **后端地址可配置**（⚙），默认 `http://127.0.0.1:8000`。

## 五、反风控与合规

- 扩展**手动触发**、**就地读取**，**不发起抓取/列表请求**，天然低风控风险。
- 仅用于**个人求职自用**，遵守 Boss 直聘服务条款。
- DOM 选择器集中在 `browser-extension/content_script.js`，站点改版后仅需维护此处。

## 六、配置要点（config.yaml）

- `search`：关键词 / `salary_min`（元/月）/ 目标岗位 / 必备技能 / 加分词 / 排除词。
- `scoring.engine`：`llm`（默认，后端 LLM 评分，失败自动回退规则）| `hybrid` | `local`（0 token）。
- `llm`：provider、base_url、api_key（环境变量或内联）、model。

## 七、后续可扩展

- 简历导出 PDF/DOCX（`tools/resume_parser.py` 已留 `export_*`）。
- AI 代聊（本轮已移除自动投递/代聊编排；如需可基于 `LLMClient` 补成被动回复服务）。
- 一键投递（需人工确认、遵守平台频率限制，谨慎）。
- 更多就地分析维度（JD 关键词提取、薪酬区间可视化对比等）。