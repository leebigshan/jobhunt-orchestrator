"""Boss 求职辅助 —— 本地后端服务（FastAPI）。

对应使用路径：插件把当前页职位 POST 到 /ext/*，后端分析/评估/优化后返回 JSON，
插件就地展示。LLM key 只留在本机后端，不进浏览器。

端点：
  GET  /info           配置概览（供前端展示已填写的求职偏好）
  GET  /health         健康检查
  GET  /ext/ping       扩展连通性 + 配置概要
  POST /ext/assess     职位综合评估（匹配度 + 薪资合理性 + 结论）
  POST /ext/optimize   基于 JD 优化简历 + 事实保护
  POST /ext/greeting   个性化打招呼语
  POST /ext/chat-tone  HR 沟通回复话术
  POST /ext/interview  面试考察点预测
  POST /ext/summary    一句话岗位速览
  POST /ext/pack       一键打包（评估+速览+话术+面试+简历优化，一次返回）
启动：`python -m web`  或  `python -m uvicorn web.app:app --host 127.0.0.1 --port 8000`
"""
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from tools.config import load_config
from web.ext_api import include_extension_api

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

app = FastAPI(title="Boss 求职辅助 · 本地后端", version="2.0.0")

# 浏览器扩展需要跨域访问本机后端；仅绑定 127.0.0.1，非对外服务
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 浏览器扩展后端路由（/ext/*）
include_extension_api(app)


@app.get("/info", summary="运行配置概览")
async def info():
    """返回已填写的求职偏好与 LLM 概要，供前端展示/校验。"""
    cfg = load_config()
    return {
        "user_name": cfg.get("user", {}).get("name"),
        "search": {
            "keywords": cfg.get("search", {}).get("keywords"),
            "salary_min": cfg.get("search", {}).get("salary_min"),
            "target_roles": cfg.get("search", {}).get("target_roles"),
            "skills_required": cfg.get("search", {}).get("skills_required"),
        },
        "llm_provider": cfg.get("llm", {}).get("provider"),
        "llm_model": cfg.get("llm", {}).get("model"),
        "llm_configured": bool(cfg.get("llm", {}).get("api_key")),
        "scoring_engine": cfg.get("scoring", {}).get("engine"),
    }


@app.get("/health", summary="健康检查")
async def health():
    return {"ok": True}