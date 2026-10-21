"""浏览器扩展的后端 API（FastAPI router）。

插件 content script 就地读取当前 Boss 详情页的职位信息，POST 到这里，
由后端复用 LLMClient / 评分 / 薪资工具做分析与简历优化，回传 JSON。
LLM key 不暴露进浏览器，逻辑全在本机 Python 底座。

端点（均为插件可调用的分析接口）：
  GET  /ext/ping         连通性 + 配置概要
  POST /ext/assess       职位综合评估（匹配度 + 薪资合理性 + 深度分析 analysis_md）
  POST /ext/analysis     深度人岗匹配分析（岗位画像/匹配点/差距/风险/行动建议）
  POST /ext/plan         面试准备计划（7 天清单/高频题/项目包装/反问建议）
  POST /ext/company      公司情报（业务/岗位定位/风险红旗/面经重点，常识+JD 推断）
  POST /ext/salary-talk  谈薪策略（区间判断/开价/压价应对/时机红线）
  POST /ext/self-intro   自我介绍（30 秒/1 分钟/3 分钟三档，基于简历真实经历）
  POST /ext/star         STAR 项目讲稿（简历项目 S/T/A/R 包装 + 深挖防线）
  POST /ext/optimize     简历优化（基于当前职位 JD，含事实保护，固定 Markdown 简历结构）
  POST /ext/greeting     打招呼语智能生成
  POST /ext/chat-tone    HR 沟通回复话术建议
  POST /ext/interview    面试考察点 / 模拟问题预测
  POST /ext/summary      一句话岗位速览（JD 太长的快速摘要）
  POST /ext/pack         一键打包（评估+深度分析+速览+话术+面试一次返回）

  Prompt 设计约定：所有 LLM 端点锁死输出格式（MD_FORMAT / 行格式契约），
  结构化 Markdown 固定小节名，前端 md.js 逐节渲染；分析类融合 base_resume。
"""
import json
import logging
import re
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel

from tools import salary_utils
from tools.config import load_config
from tools.llm_client import LLMClient
from tools.resume_parser import validate_resume_integrity
from tools.scoring import score_local

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ext", tags=["browser-extension"])


# ------------------------------------------------------------------ 连接/装配

@router.get("/ping")
async def ping():
    """扩展连通性检测。返回后端状态与当前配置概要。"""
    try:
        cfg = _load_cfg()
        return {"ok": True,
                "engine": cfg.get("scoring", {}).get("engine"),
                "model": cfg.get("llm", {}).get("model"),
                "salary_min": cfg.get("search", {}).get("salary_min"),
                "llm_configured": bool(cfg.get("llm", {}).get("api_key"))}
    except Exception:
        return {"ok": True, "engine": None, "model": None,
                "salary_min": None, "llm_configured": False}


class JobPage(BaseModel):
    """插件从当前详情页解析出的职位基础信息。"""
    title: str = ""
    company: str = ""
    location: str = ""
    salary_range: str = ""
    jd_text: str = ""
    url: str = ""
    job_tags: list[str] = []          # 职位标签/福利（如 ["五险一金","双休"]）
    interviewer: str = ""             # 沟通对象名（如 HR 昵称）
    base_resume: str = ""             # 可选：插件上传的 Markdown 简历（评分/优化参考）


class ResumeRequest(JobPage):
    """/optimize 请求体：职位信息 + 简历优化入参（扁平 JSON）。"""
    focus: str = ""


class ChatToneRequest(JobPage):
    """/chat-tone 请求体：职位信息 + HR 最新消息（扁平 JSON）。"""
    message: str = ""


# 每次请求独立读配置（插件手动触发、量小，保证拿到最新配置）
def _load_cfg() -> dict:
    return load_config("config.yaml")


def _client(cfg: dict) -> LLMClient:
    return LLMClient(cfg)


async def run_llm(client: LLMClient, prompt: str, system: str = "",
                  max_tokens: int = 800) -> str:
    """调 LLM 并承载异常，失败返回空串（前端可提示降级）。"""
    try:
        return await client.complete(prompt, system=system, max_tokens=max_tokens)
    except Exception as e:
        logger.warning("LLM 调用失败: %s", e)
        return ""


# ---------------------------------------------------------------- Prompt 设计
# 前端按固定 Markdown 结构渲染（md.js），prompt 必须锁死输出格式；
# 分析类任务要求"分析更多"：画像/匹配/差距/风险/建议多维度展开。

MD_FORMAT = """输出格式硬性要求（违反视为不合格）：
1. 纯 Markdown 正文：不要用 ``` 包裹全文、不要 HTML、不要客套开场白和总结套话。
2. 只允许这些结构：`## 小节`、`### 子节`、`- ` 无序列表、`1. ` 有序列表、**加粗**、`行内代码`、`> ` 引用。
3. 小节标题必须与我指定的小节名完全一致，顺序不变，不得增删小节。
4. 每个小节 3-5 条要点，每条一句话 ≤40 字，信息密度优先，禁止空话套话。
5. 全文中文输出（技术名词保留英文）。"""

SCORE_JSON_FORMAT = """只输出 JSON（不要代码块、不要多余文字）：
{"score": 0到100的整数, "reason": "30字内评分依据", "matched_skills": ["命中/契合的技能"], "verdict": "值得投|考虑|不建议"}"""


def _resume_hint(req, limit: int = 4000, purpose: str = "对照评估") -> str:
    """简历融合提示：评估/分析/话术都把加载的简历用起来。"""
    md = (getattr(req, "base_resume", "") or "").strip()
    if md:
        return f"\n我的简历（用于{purpose}，必须结合简历内容分析，引用简历中的真实技能/经历）：\n{md[:limit]}"
    return "\n（未提供简历，仅基于 JD 与求职偏好分析，匹配点与差距按通用假设给出）"


def _job_brief(req) -> str:
    return (f"职位：{req.title} @ {req.company}"
            f"（{req.location or '未知'}，{req.salary_range or '薪资面议'}）\n"
            f"职位描述：\n{(req.jd_text or '')[:3000]}")


def _deep_analysis_prompt(req, search: dict) -> str:
    """深度分析（/ext/analysis 与 /assess、/pack 的 analysis_md 共用）。

    固定 5 小节结构，前端逐节渲染；要求结合简历展开人岗对照。
    """
    return f"""你是资深求职顾问+技术招聘专家。对目标职位做深度人岗匹配分析，要求分析深入、结论具体、可指导行动。
求职偏好：目标岗位={search.get('target_roles', [])}，必备技能={search.get('skills_required', [])}，加分技能={search.get('skills_bonus', [])}，排除词={search.get('exclude_keywords', [])}。
{_job_brief(req)}{_resume_hint(req)}

严格按以下 5 个小节输出（小节名一字不差）：
## 🎯 岗位画像
（岗位核心职责/团队定位/隐含要求 3-4 条，从 JD 推断）
## 💪 人岗匹配点
（逐条对照简历真实技能与经历，说明为什么匹配，3-5 条）
## 📉 简历差距与补齐建议
（JD 要求但简历薄弱/缺失的点，每条给出具体补齐动作，3-5 条）
## ⚠️ 风险与红旗
（JD 中的模糊点/压榨信号/技术栈错配/成长性风险，2-4 条，没有就写"未发现明显红旗"并解释）
## 🚀 行动建议
（投递优先级、简历修改重点、面试准备重点，3-4 条）

{MD_FORMAT}"""


def _prep_plan_prompt(req, search: dict) -> str:
    """面试准备计划（/ext/plan）：固定 4 小节，输出可执行清单。"""
    return f"""你是资深面试教练。针对目标职位制定面试准备计划，要求可执行、有针对性、时间可落地。
{_job_brief(req)}{_resume_hint(req, 2500, "包装项目经历")}
必备技能={search.get('skills_required', [])}，加分技能={search.get('skills_bonus', [])}。

严格按以下 4 个小节输出（小节名一字不差）：
## 📅 7 天准备清单
（按 D1-D7 列 7 条，每条一个具体动作，贴合岗位 JD）
## 🔥 高频面试题与答题要点
（8-10 题，`### 问题` 下用 2-3 条要点作答方向，覆盖技术/项目/动机）
## 💼 项目经历包装建议
（结合简历真实项目，给出讲法/量化点/深挖防线，3-4 条）
## ❓ 反问面试官的问题
（体现思考深度的反问 3 条，按团队/技术/成长分类）

{MD_FORMAT}"""


def _company_prompt(req) -> str:
    """公司情报（/ext/company）：业务/岗位定位/风险红旗/面经重点（基于公开常识与 JD 推断）。"""
    return f"""你是资深求职顾问兼行业研究员。对目标公司与该职位做情报分析（基于公开常识与 JD 信息推断，不确定处标注「待核实」，不编造融资/人数等具体数字）。
{_job_brief(req)}

严格按以下 4 个小节输出（小节名一字不差）：
## 🏢 公司与业务
（业务方向/产品/商业模式/行业位置，4-5 条）
## 🧭 团队与岗位定位
（该岗位在团队中的角色、上下游协作、成长空间，3-4 条）
## ⚠️ 风险与红旗
（加班/稳定性/业务风险/面试陷阱等需注意点，3-4 条；无明显风险就写常规注意事项）
## 🎯 面经与考察重点
（该类公司/岗位常见考察方向与准备提示，3-5 条）

{MD_FORMAT}"""


def _salary_talk_prompt(req, search: dict) -> str:
    """谈薪策略（/ext/salary-talk）：区间判断/开价策略/压价应对/时机红线。"""
    return f"""你是资深薪资谈判教练。基于岗位信息与候选人简历给出谈薪策略。
{_job_brief(req)}{_resume_hint(req, 2500, "判断薪资竞争力与谈判筹码")}
期望薪资下限={search.get('salary_min', '未知')}K（配置值，可作为参考基线）。

严格按以下 4 个小节输出（小节名一字不差）：
## 💰 薪资区间判断
（结合 JD 区间与市场常识给出合理区间判断与依据，3-4 条）
## 📈 开价策略
（期望值怎么报、留多少谈判空间、如何锚定，3-4 条）
## 🛡 应对压价话术
（3 种典型压价场景，`### 场景` 下给 1-2 句可直接用的话术）
## ⏰ 谈判时机与红线
（什么阶段谈、什么信号该坚持/该撤，3-4 条）

{MD_FORMAT}"""


def _self_intro_prompt(req) -> str:
    """自我介绍（/ext/self-intro）：30 秒/1 分钟/3 分钟三档，基于简历真实经历。"""
    return f"""你是资深面试教练。为候选人准备贴合目标岗位的自我介绍（只用简历真实经历组织语言，不虚构、不新增数字）。
{_job_brief(req)}{_resume_hint(req, 3500, "撰写自我介绍")}

严格按以下 3 个小节输出（小节名一字不差）：
## ⏱ 30 秒版
（开场一句话 + 核心匹配点，直接可背）
## 🎯 1 分钟版
（加入 1 个代表性项目与简历中的量化结果）
## 🚀 3 分钟版
（完整履历主线 + 2 个项目亮点 + 为什么选这个岗位，分段自然口语）

{MD_FORMAT}"""


def _star_prompt(req) -> str:
    """STAR 项目讲稿（/ext/star）：简历项目按 S/T/A/R 包装 + 深挖防线。"""
    return f"""你是资深面试教练。从简历中挑 2-3 个最贴合目标岗位的项目，写成面试讲稿（只用简历真实经历，量化数字沿用简历原值，不得新造）。
{_job_brief(req)}{_resume_hint(req, 3500, "包装项目讲稿")}

输出结构硬性要求：
- 开头用小节名 `## ⭐ 项目讲稿（STAR）`，下面写一行总起（为什么挑这几个项目）
- 然后每个项目一个小节，小节名格式 `### 项目 N：项目名`（项目名用简历原名）
- 每个项目内按 4 条写（加粗标记一字不差）：
- **S**情境：1-2 句
- **T**任务：1 句
- **A**行动：3-4 条（突出技术决策与难点）
- **R**结果：1-2 句（用简历中的量化结果）
- 每个项目末尾加一行 `> 🛡 深挖防线：`（面试官最可能追问的 2 个深挖点与应答要点，顿号分隔）"""


async def score_match(cfg: dict, page: JobPage) -> tuple[float, str, list[str], str]:
    """匹配度评分（/assess 与 /pack 共用）。

    scoring.engine 控制通道：
      - local  → 纯规则（0 token）
      - hybrid / llm → 后端 LLM 精评（可参考插件上传的简历），失败自动回退规则

    返回 (score, reason, matched_skills, engine_used)；
    engine_used ∈ {"llm", "local", "local_fallback"}。
    """
    search = cfg.get("search", {})
    scoring = cfg.get("scoring", {})
    engine = (scoring.get("engine") or "local").lower()

    # 本地规则分：local 通道直接用；LLM 通道用作回退兜底
    local_score, local_reason, local_matched = score_local(
        page.title or "", page.jd_text or "", search,
        scoring.get("weights", {}), scoring.get("caps", {}))
    if engine == "local":
        return local_score, local_reason, local_matched, "local"

    resume_hint = _resume_hint(page, 3000, "匹配度评分（简历与 JD 逐项对照）")

    prompt = f"""你是严格的求职匹配度评估专家。综合我的求职偏好与简历，评估目标职位的匹配度（有简历时必须逐项对照简历真实技能/经历打分）。
求职偏好：目标岗位={search.get('target_roles', [])}，必备技能={search.get('skills_required', [])}，加分技能={search.get('skills_bonus', [])}，加分词={search.get('boost_keywords', [])}，排除词={search.get('exclude_keywords', [])}。
职位：{page.title} @ {page.company}（{page.location or '未知'}，{page.salary_range or '薪资面议'}）
职位描述：
{page.jd_text[:2500]}{resume_hint}

{SCORE_JSON_FORMAT}"""
    text = await run_llm(_client(cfg), prompt,
                         system="只输出 JSON，不要任何多余文字。", max_tokens=300)
    try:
        m = re.search(r"\{.*\}", text or "", re.S)
        if not m:
            raise ValueError("LLM 未返回 JSON")
        data = json.loads(m.group(0))
        score = max(0.0, min(100.0, float(data["score"])))
        reason = str(data.get("reason") or "").strip()
        matched = [str(x) for x in (data.get("matched_skills") or [])][:8]
        if not reason:
            raise ValueError("评分依据为空")
        return score, reason, matched, "llm"
    except Exception as e:
        logger.warning("LLM 评分不可用(%s)，回退本地规则评分", e)
        return local_score, local_reason, local_matched, "local_fallback"


# ------------------------------------------------------------------ 评估

@router.post("/assess")
async def assess(page: JobPage):
    """当前职位综合评估：匹配度(评分引擎，llm/hybrid 走 LLM，可参考上传简历) + 薪资合理性 + 深度分析(analysis_md)。"""
    import asyncio

    cfg = _load_cfg()
    search = cfg.get("search", {})
    # 1) 匹配度评分 + 深度分析并行（都融合上传的简历）
    (score, reason, matched, engine_used), analysis_md = await asyncio.gather(
        score_match(cfg, page),
        run_llm(_client(cfg), _deep_analysis_prompt(page, search),
                system="你是资深求职顾问+技术招聘专家，按指定 Markdown 小节结构输出中文分析。",
                max_tokens=1600),
    )
    # 2) 薪资合理性：config.search.salary_min 是「元/月」，折算成 K 比对
    salary_min_yuan = search.get("salary_min") or 0
    expected_min_k = salary_min_yuan / 1000.0 if salary_min_yuan else None
    meet, salary_note = salary_utils.salary_meets_expectation(page.salary_range, expected_min_k)
    q_score, q_note = salary_utils.salary_quality(page.salary_range)
    # 3) 结论
    threshold = search.get("filter_score_threshold", 60)
    verdict = "值得投" if score >= threshold and meet is not False else \
              ("考虑" if score >= 40 else "不建议")
    return {
        "match": {
            "score": score, "reason": reason, "matched_skills": matched,
            "engine": engine_used,
        },
        "salary": {
            "parsed": salary_utils.parse_salary(page.salary_range),
            "meets_expectation": meet, "note": salary_note,
            "quality_score": q_score, "quality_note": q_note,
        },
        "verdict": verdict,
        "analysis_md": analysis_md,
        "source": "current_page",
    }


# ------------------------------------------------------------------ 简历优化

def _load_base_resume(cfg: dict, req: ResumeRequest) -> str:
    """读取基础简历：优先请求体传入，否则回退到配置里的 base_resume_path。"""
    if req.base_resume.strip():
        return req.base_resume.strip()
    base_path = Path(cfg.get("user", {}).get("base_resume_path", "data/base_resume.md"))
    if base_path.exists():
        return base_path.read_text(encoding="utf-8").strip()
    # 无简历文件时用配置生成的占位简历
    name = cfg["user"].get("name", "")
    skills = "、".join(cfg.get("search", {}).get("skills_required", []))
    return f"# 简历\n姓名: {name}\n技能: {skills}\n"


@router.post("/optimize")
async def optimize(req: ResumeRequest):
    """基于当前职位 JD 优化简历。base_resume 未传时用配置基础简历。"""
    cfg = _load_cfg()
    base_md = _load_base_resume(cfg, req)

    focus_hint = f"\n优化侧重：{req.focus}" if req.focus else ""
    prompt = f"""你是资深求职简历顾问。根据职位描述把基础简历重写为针对该职位的版本，优化要深入：关键词植入、量化强化、项目描述对齐 JD、技能排序按岗位相关度。
**绝对禁止**编造或更改事实字段：学历、毕业/入职时间、工作年限、百分比、具体数字。只允许调整措辞、技能排序和项目描述侧重。
{_job_brief(req)}{focus_hint}

基础简历：
{base_md}

输出硬性要求（违反视为不合格）：
1. 纯 Markdown 简历正文，不要 ``` 包裹、不要 HTML、不要解释性开场白/结尾。
2. 固定结构（小节名一致，不得增删）：`# {req.title}方向 · 定制简历`、`## 核心优势`（3-4 条，对齐 JD 关键词）、`## 专业技能`（按岗位相关度排序的分类列表）、`## 工作经历`（### 公司/职位，要点量化）、`## 项目经历`（### 项目名，背景/动作/结果 2-4 条）。
3. JD 中的关键技术词自然融入技能与项目描述（不得虚构未掌握的技术）。
4. 每条要点 ≤40 字，动词开头，优先保留原简历中的量化数字。
5. 全文中文（技术名词保留英文）。"""
    client = _client(cfg)
    optimized = await run_llm(client, prompt,
                              system="你是资深求职简历顾问，只输出符合指定结构的 Markdown 简历。",
                              max_tokens=2000)
    if not optimized:  # LLM 失败，退回基础简历并标记
        optimized = base_md
    is_valid, violations = validate_resume_integrity(base_md, optimized)
    return {
        "optimized_md": optimized,
        "warnings": violations if not is_valid else [],
        "integrity_ok": is_valid,
    }


# ------------------------------------------------------------------ 打招呼语

@router.post("/greeting")
async def greeting(page: JobPage):
    """基于当前职位生成个性化打招呼语。"""
    cfg = _load_cfg()
    user = cfg.get("user", {})
    search = cfg.get("search", {})
    prompt = f"""你是求职者本人，在[Boss直聘]给目标职位发首次打招呼。
用户信息：{user.get('name','')}，技能={search.get('skills_required',[])}，加分词={search.get('boost_keywords',[])}。
{_job_brief(page)}{_resume_hint(page, 1500, "挑选最契合的经历/技能写进打招呼")}

生成 2 条个性化打招呼语，要求：自然不过度吹捧、点出简历中与岗位最契合的 1-2 个技能/经历、简洁（<60字）、不要需要进一步确认信息的问句。
输出硬性要求：每行一条（可含 emoji 开头），不要编号、不要引号、不要任何多余文字。"""
    client = _client(cfg)
    text = await run_llm(client, prompt, system="你正在帮求职者写打招呼语，每行一条直接输出。", max_tokens=400)
    lines = [l.strip() for l in (text or "").splitlines() if l.strip()]
    return {"greetings": lines[:5]}


# ------------------------------------------------------------------ HR 话术

@router.post("/chat-tone")
async def chat_tone(req: ChatToneRequest):
    """HR 沟通回复话术建议。req.message 为 HR 发来的最新消息。"""
    cfg = _load_cfg()
    user = cfg.get("user", {})
    search = cfg.get("search", {})
    message = req.message or ""
    prompt = f"""你是求职者，正在与 HR 沟通当前职位。你的技能={search.get('skills_required',[])}，加分词={search.get('boost_keywords',[])}。
职位：{req.title} @ {req.company}
HR 最新消息：
{message or '(无具体消息，给出常见问题的通用应答策略)'}{_resume_hint(req, 1500, "用真实经历支撑回复")} 

给出 3 条候选回复，要求：不同语气风格（专业版/亲和版/简洁版），坦诚专业、不夸大，结合简历真实技能/经历与岗位相关性，可直接粘贴发送。
输出硬性要求：3 行，每行一条；每行以「专业版：」「亲和版：」「简洁版：」开头，不要编号、不要其他文字。"""
    client = _client(cfg)
    text = await run_llm(client, prompt, system="你是求职沟通顾问，帮用户稳健回复 HR，严格按指定行格式输出。", max_tokens=500)
    return {"suggestions": (text or "").splitlines()[:12]}


# ------------------------------------------------------------------ 新增 · 面试预测 / 岗位速览 / 一键打包

@router.post("/interview")
async def interview(page: JobPage):
    """根据当前职位 JD 预测可能被问到的考察点/面试问题。"""
    if not (page.jd_text and page.jd_text.strip()):
        return {"questions": [], "note": "未获取到职位描述，无法预测"}
    prompt = f"""你是资深面试官/技术招聘顾问。基于职位描述与我的简历，预测面试中可能被问到的考察点（结合简历项目/技能深挖）。
{_job_brief(page)}{_resume_hint(page, 2500, "预测简历深挖问题")}

输出 8 条，每行一个「考察点/大概率问的问题」，覆盖四方面：①专业知识/技术栈 ②项目/实战经历（尤其简历里的项目深挖） ③软素质与求职动机 ④岗位认知/反问。
输出硬性要求：每行一条，不要编号、不要小节标题、不要任何解释性文字。"""
    client = _client(_load_cfg())
    text = await run_llm(client, prompt, system="你是求职面试辅导专家，每行一条问题直接输出。", max_tokens=700)
    lines = [l.strip() for l in (text or "").splitlines()
             if l.strip() and not l.strip().startswith(("①", "②", "③", "④", "#", "-"))]
    return {"questions": lines[:12], "note": "基于 JD 与简历的预测，实际以 HR 沟通为准"}


@router.post("/summary")
async def summary(page: JobPage):
    """一句话岗位速览：JD 太长时先给你 3 句要点速览。"""
    if not (page.jd_text and page.jd_text.strip()):
        return {"summary": "", "note": "未获取到职位描述"}
    prompt = f"""用简洁中文把下面职位描述压缩成 3 条要点速览（职责/要求/亮点各一条），方便快速判断。
职位：{page.title} @ {page.company}
职位描述：
{page.jd_text[:2500]}

输出硬性要求：每行一条，分别以「职责：」「要求：」「亮点：」开头，不要任何其他文字。"""
    client = _client(_load_cfg())
    text = await run_llm(client, prompt, system="你是求职信息整理助手，严格按指定行格式输出。", max_tokens=300)
    lines = [l.strip() for l in (text or "").splitlines() if l.strip()]
    return {"summary": "\n".join(lines[:5])}


@router.post("/pack")
async def pack(page: JobPage):
    """一键打包：一次调用返回评估 + 深度分析 + 速览 + 打招呼 + 面试预测。

    全部走后端 LLM 并行生成（评估按 scoring.engine，失败回退规则），均融合上传的简历。
    """
    import asyncio

    cfg = _load_cfg()
    client = _client(cfg)
    search = cfg.get("search", {})

    salary_min_yuan = search.get("salary_min") or 0
    expected_min_k = salary_min_yuan / 1000.0 if salary_min_yuan else None
    meet, salary_note = salary_utils.salary_meets_expectation(page.salary_range, expected_min_k)

    # ---- LLM 四项 + 匹配评分并行（格式契约锁输出，前端逐条/逐节渲染）----
    skills = "、".join(search.get("skills_required", []))
    resume_short = _resume_hint(page, 1500, "挑选最契合的经历/技能")
    prompts = [
        (f"你是求职者本人，在Boss直聘给目标职位发首次打招呼。技能={skills}。"
         f"职位：{page.title} @ {page.company}（{page.salary_range or '面议'}）\n"
         f"职位描述：{page.jd_text[:2000]}{resume_short}\n"
         f"生成 2 条个性化打招呼语，自然简洁(<60字)，点出简历中最契合的技能/经历。每行一条，不要编号、不要多余文字。",
         "你正在帮求职者写打招呼语，每行一条直接输出。", 400),
        (f"你是面试辅导专家。基于职位描述与简历预测面试考察点。职位：{page.title} @ {page.company}\n"
         f"职位描述：{page.jd_text[:3000]}{_resume_hint(page, 2500, '预测简历深挖问题')}\n"
         f"输出 8 条，每行一个考察点/问题，覆盖技术/项目深挖/动机/岗位认知。每行一条，不要编号、不要小节标题。",
         "你是求职面试辅导专家，每行一条问题直接输出。", 700),
        (f"把职位描述压缩成 3 条要点（职责/要求/亮点）。职位：{page.title} @ {page.company}\n"
         f"{page.jd_text[:2500]}\n每行一条，分别以「职责：」「要求：」「亮点：」开头，不要其他文字。",
         "你是求职信息整理助手，严格按指定行格式输出。", 300),
        (_deep_analysis_prompt(page, search),
         "你是资深求职顾问+技术招聘专家，按指定 Markdown 小节结构输出中文分析。", 1600),
    ]
    results = await asyncio.gather(
        score_match(cfg, page),
        *[run_llm(client, p, system=s, max_tokens=mt) for p, s, mt in prompts])
    (score, reason, matched, engine_used), greetings, interview_text, summary_text, analysis_md = results

    threshold = search.get("filter_score_threshold", 60)
    verdict = "值得投" if score >= threshold and meet is not False else "考虑/不建议"

    def _lines(t): return [l.strip() for l in (t or "").splitlines() if l.strip()]

    return {
        "verdict": verdict,
        "match": {"score": score, "reason": reason, "matched_skills": matched,
                  "engine": engine_used},
        "salary": {"meets_expectation": meet, "note": salary_note},
        "analysis_md": analysis_md,
        "greetings": _lines(greetings)[:5],
        "interview": _lines(interview_text)[:12],
        "summary": "\n".join(_lines(summary_text)[:5]),
        "note": f"pack = 评估(评分引擎:{engine_used}) + 深度分析/打招呼/面试/速览(LLM)。LLM 未配置时自动降级。",
    }


# ------------------------------------------------------------------ 深度分析 / 准备计划

@router.post("/analysis")
async def analysis(page: JobPage):
    """深度人岗匹配分析：岗位画像/匹配点/差距/风险/行动建议（融合上传简历，Markdown 固定小节）。"""
    cfg = _load_cfg()
    search = cfg.get("search", {})
    text = await run_llm(_client(cfg), _deep_analysis_prompt(page, search),
                         system="你是资深求职顾问+技术招聘专家，按指定 Markdown 小节结构输出中文分析。",
                         max_tokens=1600)
    return {
        "analysis_md": text or "> ⚠️ LLM 未配置或调用失败，深度分析不可用。",
        "engine": cfg.get("scoring", {}).get("engine", "local"),
    }


@router.post("/plan")
async def plan(page: JobPage):
    """面试准备计划：7 天清单/高频题/项目包装/反问建议（融合上传简历，Markdown 固定小节）。"""
    cfg = _load_cfg()
    search = cfg.get("search", {})
    text = await run_llm(_client(cfg), _prep_plan_prompt(page, search),
                         system="你是资深面试教练，按指定 Markdown 小节结构输出中文计划。",
                         max_tokens=1600)
    return {
        "plan_md": text or "> ⚠️ LLM 未配置或调用失败，准备计划不可用。",
    }


# ------------------------------------------------------------------ 公司情报 / 谈薪 / 自我介绍 / STAR 讲稿

@router.post("/company")
async def company(page: JobPage):
    """公司情报：业务/岗位定位/风险红旗/面经重点（基于常识与 JD 推断，Markdown 固定小节）。"""
    cfg = _load_cfg()
    text = await run_llm(_client(cfg), _company_prompt(page),
                         system="你是资深求职顾问兼行业研究员，按指定 Markdown 小节结构输出中文分析，不确定信息标注「待核实」。",
                         max_tokens=1200)
    return {"company_md": text or "> ⚠️ LLM 未配置或调用失败，公司情报不可用。"}


@router.post("/salary-talk")
async def salary_talk(page: JobPage):
    """谈薪策略：区间判断/开价策略/压价应对/时机红线（融合上传简历，Markdown 固定小节）。"""
    cfg = _load_cfg()
    search = cfg.get("search", {})
    text = await run_llm(_client(cfg), _salary_talk_prompt(page, search),
                         system="你是资深薪资谈判教练，按指定 Markdown 小节结构输出中文策略。",
                         max_tokens=1200)
    return {"salary_md": text or "> ⚠️ LLM 未配置或调用失败，谈薪策略不可用。"}


@router.post("/self-intro")
async def self_intro(page: JobPage):
    """自我介绍：30 秒/1 分钟/3 分钟三档（基于简历真实经历，Markdown 固定小节）。"""
    cfg = _load_cfg()
    text = await run_llm(_client(cfg), _self_intro_prompt(page),
                         system="你是资深面试教练，按指定 Markdown 小节结构输出中文自我介绍，只用简历真实经历。",
                         max_tokens=1600)
    return {"intro_md": text or "> ⚠️ LLM 未配置或调用失败，自我介绍不可用。"}


@router.post("/star")
async def star(page: JobPage):
    """STAR 项目讲稿：简历项目按 S/T/A/R 包装 + 深挖防线（Markdown 固定结构）。"""
    cfg = _load_cfg()
    text = await run_llm(_client(cfg), _star_prompt(page),
                         system="你是资深面试教练，按指定 Markdown 结构输出中文项目讲稿，只用简历真实经历。",
                         max_tokens=1800)
    return {"star_md": text or "> ⚠️ LLM 未配置或调用失败，STAR 项目讲稿不可用。"}


# 装配到主 app 的便捷函数
def include_extension_api(app) -> None:
    app.include_router(router)