"""薪资解析与合理性判断工具。

供 Boss 辅助包的「薪资/门槛合理性分析」使用：
  - 解析收益上宛如 "15k-25k" / "15K-25K" / "25-40K·14薪" / "面议" / "1-2万" 等
  - 判断岗位薪资是否达到用户期望下限、是否合理（下限/上限/含金量）
不依赖 LLM，纯规则，0 token。
"""
import re

MONTH_UNIT = 10000.0  # 元 / K 的换算基准：1k = 1000 元


def parse_salary(raw: str | None) -> dict:
    """解析薪资字符串，返回结构：
    {ok, low_k, high_k, k14, unit, raw}
    单位统一为「千元/月」K。无法解析时 ok=False。
    支持：'15k-25k'、'15-25K'、'15K-25K·14薪'、'20K'、'面议'、'1-2万/月'。
    """
    result = {"ok": False, "low_k": None, "high_k": None, "k14": None, "unit": "", "raw": raw or ""}
    s = (raw or "").strip().lower().replace("／", "/").replace(" ", "")
    if not s or "面议" in s or "元/天" in s or "日结" in s:
        return result

    def to_k(seg: str) -> float:
        if "万" in seg:
            m = re.search(r"([\d.]+)\s*万", seg)
            return float(m.group(1)) * 10.0 if m else 0.0  # 万/月 → K
        m = re.search(r"([\d.]+)\s*k", seg)
        if m:
            return float(m.group(1))
        m = re.search(r"([\d.]+)\s*k/月", seg)
        if m:
            return float(m.group(1))
        return 0.0

    # K 区间：15k-25k / 15-25k / 20k-30K
    m = re.search(r"([\d.]+)\s*k?\s*[-~至到]\s*([\d.]+)\s*k", s)
    if m:
        result["low_k"], result["high_k"] = to_k(f"{m.group(1)}k"), to_k(f"{m.group(2)}k")
        result["ok"] = True
    else:
        # K 单值：20k
        m = re.search(r"([\d.]+)\s*k", s)
        if m:
            v = to_k(f"{m.group(1)}k")
            result["low_k"] = result["high_k"] = v
            result["ok"] = True
        else:
            # 万区间：1-2万
            m = re.search(r"([\d.]+)-([\d.]+)\s*万", s)
            if m:
                result["low_k"], result["high_k"] = to_k(f"{m.group(1)}万"), to_k(f"{m.group(2)}万")
                result["ok"] = True

    # 14 薪 / 13薪 / 16薪
    m14 = re.search(r"(\d{1,2})\s*薪", s)
    if m14:
        result["k14"] = int(m14.group(1))
    result["unit"] = s
    return result


def salary_meets_expectation(raw: str | None, expected_min_k: float | None) -> tuple[bool | None, str]:
    """判断岗位薪资是否达到期望下限。expected_min_k=None → 返回 None(未设定)。
    返回 (达到与否, 说明)。无法解析 → (None, 无法解析)。
    """
    if not expected_min_k:
        return None, "未设置期望薪资下限"
    p = parse_salary(raw)
    if not p["ok"]:
        return None, f"薪资不可解析({raw or '面议'})"
    high = p["high_k"] or p["low_k"] or 0.0
    if high < expected_min_k:
        return False, f"上限 {high:.0f}K 仍低于期望 {expected_min_k:.0f}K"
    if (p["low_k"] or high) >= expected_min_k:
        return True, f"下限 {(p['low_k'] or high):.0f}K ≥ 期望 {expected_min_k:.0f}K"
    return None, f"区间含期望({(p['low_k'] or 0):.0f}-{high:.0f}K)，需综合判断"


def salary_quality(raw: str | None) -> tuple[float, str]:
    """给岗位薪资质量打人气分 0-100（越高越值得重视）。纯规则。"""
    p = parse_salary(raw)
    if not p["ok"] or not p["high_k"]:
        return 0.0, "面议/未标注"
    high = p["high_k"]
    score = 0.0
    if high >= 60:
        score += 40
    elif high >= 35:
        score += 32
    elif high >= 20:
        score += 24
    else:
        score += 10
    # 薪数
    score += min((p["k14"] or 12) - 12, 3) * 5  # 13薪+5, 14+10...
    # 区间宽度（越稳越加分）
    low = p["low_k"] or high
    if low and high > low:
        ratio = high / low
        if 1.0 <= ratio <= 1.4:
            score += 8
    return min(100.0, score), f"{p.get('low_k') or ''}-{p.get('high_k')}K" + (f"·{p['k14']}薪" if p.get("k14") else "")