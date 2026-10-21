"""人生战：resume 工具——事实抽取 + 完整性校验 + 多格式导出（MD/PDF/DOCX）。
"""
import logging
import re
from pathlib import Path

logger = logging.getLogger(__name__)


def extract_facts(text: str) -> list[str]:
    """抽取含关键事实（日期/年限/百分比/数字）的行。"""
    facts = []
    patterns = [r"(19|20)\d{2}", r"\d{1,3}\s?%", r"\d+\s*年", r"本科|硕士|博士|大专|学士"]
    for line in (text or "").splitlines():
        s = line.strip()
        if s and any(re.search(p, s) for p in patterns):
            facts.append(s)
    return facts


def validate_resume_integrity(original: str, tailored: str) -> tuple[bool, list[str]]:
    """原简历的关键 token（年份、学历、百分比）必须在定制后保留。"""
    violations = []
    orig_tokens = set(re.findall(r"(19|20)\d{2}|本科|硕士|博士|\d{1,3}%", original or ""))
    for tok in orig_tokens:
        if tok and tok not in (tailored or ""):
            violations.append(f"丢失: {tok}")
    return (not violations, violations)


def export_md(content: str, path: Path):
    Path(path).write_text(content, encoding="utf-8")


def export_pdf(content: str, path: Path):
    try:
        from fpdf import FPDF
    except ImportError:
        logger.warning("fpdf2 未安装，跳过 PDF 导出")
        return False
    pdf = FPDF()
    pdf.add_page()
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.set_font("helvetica", size=11)
    for line in content.splitlines():
        pdf.multi_cell(0, 6, line)
    pdf.output(str(path))
    return True


def export_docx(content: str, path: Path):
    try:
        from docx import Document
    except ImportError:
        logger.warning("python-docx 未安装，跳过 DOCX 导出")
        return False
    doc = Document()
    for line in content.splitlines():
        if line.strip():
            doc.add_paragraph(line)
    doc.save(str(path))
    return True


def export_resume(content: str, out_stem: Path, fmt: str = "md"):
    """按格式导出。返回导出路径及是否成功。"""
    out_stem = Path(out_stem)
    out_stem.parent.mkdir(parents=True, exist_ok=True)
    if fmt == "pdf":
        p = out_stem.with_suffix(".pdf")
        return str(p), export_pdf(content, p)
    if fmt == "docx":
        p = out_stem.with_suffix(".docx")
        return str(p), export_docx(content, p)
    p = out_stem.with_suffix(".md")
    export_md(content, p)
    return str(p), True