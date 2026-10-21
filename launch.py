"""Boss 求职辅助 · 本地后端一键启动（不操作浏览器）。

职责只有一件事：启动本地 FastAPI 后端（web/app.py，提供 /ext/* 分析 API）。
浏览器与插件由用户自行管理：
  1. 自己打开浏览器（Firefox / Chrome 均可），进入 Boss 直聘并登录。
  2. 手动加载 browser-extension/ 插件（见 browser-extension/README.md）。
  3. 在职位详情页点插件图标 → 页面右侧滑出常驻侧边栏 → 就地分析。

用法：
  python launch.py               # 启动后端 http://127.0.0.1:8000
  python launch.py --port 9000   # 指定端口
  python launch.py --reload      # 开发模式热重载

退出：Ctrl+C。
"""
import argparse
import sys

import uvicorn

HTTP_PORT = 8000


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Boss 求职辅助 · 本地后端启动")
    p.add_argument("--config", default="config.yaml", help="配置文件路径（仅做启动前自检）")
    p.add_argument("--port", type=int, default=HTTP_PORT, help="后端端口")
    p.add_argument("--host", default="127.0.0.1", help="监听地址（默认仅本机）")
    p.add_argument("--reload", action="store_true", help="代码热重载（开发用）")
    return p.parse_args(argv)


def preflight(config_path: str, port: int) -> None:
    """启动前自检：配置可加载、LLM key 是否就绪（不阻断启动，仅提示）。"""
    try:
        from tools.config import get_llm_api_key, load_config
        cfg = load_config(config_path)
        key = get_llm_api_key(cfg)
        llm = cfg.get("llm", {})
        if key:
            print(f"[launch] LLM 就绪: {llm.get('base_url', '')}  model={llm.get('model', '')}")
        else:
            print("[launch] ⚠️ 未配置 LLM key：LLM 功能不可用，仅评分可用。"
                  "请在 config.yaml 的 llm.api_key 填写后重启。")
    except Exception as e:  # 自检失败不阻断启动
        print(f"[launch] 配置自检跳过: {e}")
    print(f"[launch] 后端启动中: http://127.0.0.1:{port}/ext/ping")
    print("         浏览器 / 插件请自行打开与加载（见 browser-extension/README.md）。"
          "退出按 Ctrl+C。")


def main(argv=None) -> int:
    args = parse_args(argv)
    preflight(args.config, args.port)
    uvicorn.run(
        "web.app:app",
        host=args.host,
        port=args.port,
        log_level="info",
        reload=args.reload,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
