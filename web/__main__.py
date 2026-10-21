"""python -m web 启动入口：本地后端服务。"""
import uvicorn

if __name__ == "__main__":
    uvicorn.run("web.app:app", host="127.0.0.1", port=8000, reload=False)