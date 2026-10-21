"""统一 LLM 客户端，多 provider（claude | openai | openai_compatible | ollama）。

核心能力（吸收 jobs-hunt-agent 的 retry/JSON 封装 + goodjobs 的 Pydantic 约束输出）：
  - provider 抽象
  - 指数退避重试
  - markdown 代码块剥离 + JSON 解析
  - format=schema 强制 JSON（openai_compatible/ollama 支持）
"""
import json
import logging
from typing import Any, Optional, Type

import httpx
from pydantic import BaseModel
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
    before_sleep_log,
)

try:
    from tools.config import get_llm_api_key
except ImportError:  # 直接以 tools/ 为 sys.path 运行时的兜底
    from config import get_llm_api_key

logger = logging.getLogger(__name__)

MAX_RETRIES = 3
_RETRYABLE = (httpx.HTTPStatusError, httpx.ConnectError, httpx.TimeoutException)


class LLMError(RuntimeError):
    pass


class LLMClient:
    """轻量统一客户端，无 provider 强依赖，基于 httpx。"""

    def __init__(self, config: dict):
        llm = config.get("llm", {})
        self.provider = llm.get("provider", "openai_compatible")
        self.base_url = llm.get("base_url", "").rstrip("/")
        self.model = llm.get("model", "gpt-4o-mini")
        self.max_tokens = llm.get("max_tokens", 1024)
        self.temperature = llm.get("temperature", 0.2)
        # 统一解析：config 内联 api_key 优先，环境变量后备（见 tools/config.get_llm_api_key）
        self.api_key = get_llm_api_key(config)
        self.chat_model = llm.get("chat_model", self.model)
        self.chat_max_tokens = llm.get("chat_max_tokens", 512)

    # ------------------------------------------------------------------ 基础调用

    @retry(
        retry=retry_if_exception_type(_RETRYABLE),
        stop=stop_after_attempt(MAX_RETRIES),
        wait=wait_exponential(multiplier=1, min=2, max=30),
        before_sleep=before_sleep_log(logger, logging.WARNING),
        reraise=True,
    )
    async def _chat(self, messages: list[dict], model: str, max_tokens: int) -> str:
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": self.temperature,
        }

        headers = {"Content-Type": "application/json"}

        # 不同 provider 的请求构造
        if self.provider == "claude":
            # Claude 用系统消息独立字段
            sys_msgs = [m["content"] for m in messages if m.get("role") == "system"]
            msgs = [m for m in messages if m.get("role") != "system"]
            if sys_msgs:
                payload["system"] = "\n".join(sys_msgs)
            payload["messages"] = msgs
            headers["x-api-key"] = self.api_key
            if not self.base_url:
                self.base_url = "https://api.anthropic.com/v1"
            url = f"{self.base_url}/messages"
        elif self.provider == "ollama":
            # Ollama: http://localhost:11434/api/chat
            if "chat" not in self.base_url:
                self.base_url = (self.base_url or "http://localhost:11434").rstrip("/")
                url = f"{self.base_url}/api/chat"
            else:
                url = self.base_url.rstrip("/") + "/api/chat" if "api" not in self.base_url else self.base_url
            payload.pop("temperature")  # ollama 用 options
            payload["options"] = {"temperature": self.temperature}
            url = (self.base_url or "http://localhost:11434").rstrip("/") + "/api/chat"
        else:
            # openai / openai_compatible
            url = f"{self.base_url}/chat/completions"
            if self.api_key:
                headers["Authorization"] = f"Bearer {self.api_key}"

        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                resp = await client.post(url, json=payload, headers=headers)
                resp.raise_for_status()
                data = resp.json()
        except httpx.HTTPStatusError as e:
            logger.error("LLM HTTP %s: %s", e.response.status_code, e.response.text[:300])
            raise

        # 解析响应
        text = ""
        if self.provider == "claude":
            text = data.get("content", [{}])[0].get("text", "")
        elif self.provider == "ollama":
            text = data.get("message", {}).get("content", "")
        else:
            text = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        text = (text or "").strip()
        if not text:
            logger.warning("LLM 返回空内容")
        return text

    # ------------------------------------------------------------------ 公开接口

    def _system_user(self, system: str, user: str) -> list[dict]:
        msgs = []
        if system:
            msgs.append({"role": "system", "content": system})
        msgs.append({"role": "user", "content": user})
        return msgs

    async def complete(self, prompt: str, *, system: str = "", model=None, max_tokens=None) -> str:
        """纯文本补全。"""
        m = model or self.model
        mt = max_tokens or self.max_tokens
        return await self._chat(self._system_user(system, prompt), m, mt)

    async def complete_json(self, prompt: str, *, system: str = "", model=None, max_tokens=None,
                            schema: Optional[Type[BaseModel]] = None, fallback=None) -> Optional[dict]:
        """返回 parsed dict；schema 非空时尝试强制 JSON。"""
        m = model or self.model
        mt = max_tokens or self.max_tokens
        raw = await self._chat(self._system_user(system, prompt), m, mt)
        parsed = _parse_json(raw)
        if parsed is None and fallback is not None:
            return fallback
        return parsed

    async def complete_pydantic(self, prompt: str, schema: Type[BaseModel], *, system: str = "",
                                model=None, max_tokens=None) -> Optional[BaseModel]:
        """调用 LLM 并强制解析为 Pydantic 模型。失败返回 None。"""
        d = await self.complete_json(prompt, system=system, model=model, max_tokens=max_tokens)
        if d is None:
            return None
        try:
            return schema.model_validate(d)
        except Exception as e:
            logger.error("Pydantic 校验失败 %s: %s | raw=%r", schema.__name__, e, d)
            return None


def _parse_json(text: str) -> Optional[dict]:
    """剥离 markdown 代码块后解析 JSON。"""
    t = (text or "").strip()
    if t.startswith("```"):
        lines = t.splitlines()
        inner = lines[1:] if lines[-1].strip() == "```" else lines[1:]
        if inner and inner[-1].strip() == "```":
            inner = inner[:-1]
        t = "\n".join(inner).strip()
    try:
        return json.loads(t)
    except json.JSONDecodeError as e:
        logger.error("JSON 解析失败 | raw=%r | err=%s", text[:200], e)
        return None