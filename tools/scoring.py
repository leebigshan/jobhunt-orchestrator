"""规则评分引擎（本地 0-token 快速打分，参考 boss_Automatic + job-hunter）。

使用场景：
  - scoring.engine = local  → 纯规则
  - engine = hybrid        → 规则粗筛（预算小）+ 达标者再走 LLM 精排
  - engine = llm           → 全走 LLM（跳过本地粗筛）

返回 0-100 分 + 命中说明。
"""
import logging

logger = logging.getLogger(__name__)


def _norm(s: str) -> str:
    return (s or "").strip().lower()


def score_local(job_title: str, jd_text: str, search: dict, weights: dict, caps: dict) -> tuple[float, str, list[str]]:
    """本地规则打分。返回 (score, reason, matched_skills)。

    规则（吸收 job-hunter）：
      - exclude_keywords 命中 → 直接 0 分
      - target_roles 命中标题 → +target_role
      - 必需技能命中 → +skill_required（封顶 skill_required 上限）
      - 加分技能命中 → +skill_bonus（封顶）
      - boost_keywords 命中 → +boost
      - 综合 clamp 到 0-100
    """
    title = _norm(job_title)
    combined = title + " " + _norm(jd_text)

    # 排除词：命中直接归零
    for kw in search.get("exclude_keywords", []):
        if kw and _norm(kw) in combined:
            return 0.0, f"包含排除词:{kw}", []

    score = 0.0
    hits: list[str] = []
    matched_skills: list[str] = []

    # 目标岗位（标题命中）
    for role in search.get("target_roles", []):
        if role and _norm(role) in title:
            score += weights.get("target_role", 30)
            hits.append(f"目标岗位:{role}")
            break

    # 必需技能
    cap_req = caps.get("skill_required", 40)
    req_hits = []
    for sk in search.get("skills_required", []):
        if sk and _norm(sk) in combined:
            req_hits.append(sk)
            matched_skills.append(sk)
    if req_hits:
        bonus = min(len(req_hits) * weights.get("skill_required", 10), cap_req)
        score += bonus
        hits.append(f"必需技能:{'/'.join(req_hits[:3])}(+{bonus})")

    # 加分技能
    cap_bonus = caps.get("skill_bonus", 25)
    bonus_hits = []
    for sk in search.get("skills_bonus", []):
        if sk and _norm(sk) in combined:
            bonus_hits.append(sk)
    if bonus_hits:
        bonus = min(len(bonus_hits) * weights.get("skill_bonus", 5), cap_bonus)
        score += bonus
        hits.append(f"加分技能:{'/'.join(bonus_hits[:3])}(+{bonus})")

    # 加分关键词（boost）—— 命中任一
    for kw in search.get("boost_keywords", []):
        if kw and _norm(kw) in combined:
            score += weights.get("boost", 10)
            hits.append(f"加分词:{kw}(+10)")
            break

    # 标题负面词拦截（封顶 title_penalty）
    title_negative = search.get("title_negative", [])
    if title_negative:
        pen = min(len([w for w in title_negative if w and _norm(w) in title]) *
                  weights.get("title_negative", 0), caps.get("title_penalty", 45))

    return max(0.0, min(100.0, score)), ("、".join(hits) if hits else "无本地规则命中"), matched_skills