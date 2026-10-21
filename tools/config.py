"""配置加载与默认值。

仅保留浏览器扩展辅助场景所需的配置段（user / search / scoring / llm）。
启动浏览器时通过命令行参数覆盖，这里只负责读取 config.yaml 并做默认值补齐。
"""
import logging
import os
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)

# 默认配置（缺省字段用这里补齐）
DEFAULT_CONFIG: dict[str, Any] = {
    "user": {
        "name": "",
        "email": "",
        "phone": "",
        "base_resume_path": "data/base_resume.md",
    },
    "search": {
        "keywords": ["Python"],
        "salary_min": 0,                 # 元/月
        "target_roles": [],
        "skills_required": [],
        "skills_bonus": [],
        "exclude_keywords": [],
        "boost_keywords": [],
        "filter_score_threshold": 60,
    },
    "scoring": {
        "engine": "local",               # local | llm | hybrid（ext 用本地规则为主）
        "weights": {
            "target_role": 30,
            "skill_required": 10,
            "skill_bonus": 5,
            "boost": 10,
        },
        "caps": {"skill_required": 40, "skill_bonus": 25, "title_penalty": 45},
    },
    "llm": {
        "provider": "openai_compatible", # claude | openai | openai_compatible | ollama
        "base_url": "https://api.openai.com/v1",
        "api_key_env": "LLM_API_KEY",    # 从环境变量读取
        "api_key": "",
        "model": "gpt-4o-mini",
        "max_tokens": 1024,
        "temperature": 0.2,
        "chat_model": "gpt-4o-mini",
        "chat_max_tokens": 512,
    },
}


def load_config(path: str = "config.yaml", root: Path | None = None) -> dict:
    """加载 config.yaml，缺省字段用 DEFAULT_CONFIG 深度补齐。"""
    base = _deep_merge({}, DEFAULT_CONFIG)
    root = root or Path.cwd()
    cfg_path = root / path
    if cfg_path.exists():
        with open(cfg_path, encoding="utf-8") as f:
            user_cfg = yaml.safe_load(f) or {}
        base = _deep_merge(base, user_cfg)
    else:
        logger.warning("配置文件 %s 不存在，使用默认配置", cfg_path.resolve())
    # 兼容：把解析出的 LLM key 回填到 api_key，使各处（llm_configured 判定 / LLMClient）统一读到
    resolved = get_llm_api_key(base)
    if resolved != base.get("llm", {}).get("api_key", ""):
        base.setdefault("llm", {})["api_key"] = resolved
    return base


def _deep_merge(base: dict, override: dict) -> dict:
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _deep_merge(base[k], v)
        else:
            base[k] = v
    return base


def get_llm_api_key(config: dict) -> str:
    """读取 LLM API key，优先级：配置内联 api_key > 环境变量（api_key_env 指定的名字）。

    注意：显式写在 config.yaml 里的 key 优先——避免系统中残留的同名环境变量
    （如历史遗留的 LLM_API_KEY）静默覆盖用户配置导致 401。
    """
    llm = config.get("llm", {})
    key = llm.get("api_key", "")
    if not key:
        env_name = llm.get("api_key_env", "LLM_API_KEY")
        key = os.environ.get(env_name, "")
    return key.strip()