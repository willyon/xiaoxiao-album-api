#!/usr/bin/env python3
"""
Python Face Service 启动脚本
简化启动流程，类似 npm start
"""

import sys          # 系统相关功能，用于退出程序
import subprocess   # 子进程管理，用于启动Python应用
from pathlib import Path  # 路径操作，用于处理文件路径

def main():
    """主启动函数"""
    # 获取当前脚本所在的目录路径
    # __file__ 是当前脚本文件的完整路径
    # .parent 获取父目录，即脚本所在的目录
    # 例如：/path/to/python-ai-service/start.py -> /path/to/python-ai-service/
    current_dir = Path(__file__).parent
    
    # 虚拟环境Python路径
    venv_python = current_dir / "venv" / "bin" / "python"
    
    # 检查虚拟环境是否存在
    if not venv_python.exists():
        print("❌ 虚拟环境不存在，请先运行: python -m venv venv")
        sys.exit(1)
    
    # 检查app.py是否存在
    app_file = current_dir / "app.py"
    if not app_file.exists():
        print("❌ app.py 文件不存在")
        sys.exit(1)
    
    print("🚀 启动 Python AI Service...")
    print(f"📁 工作目录: {current_dir}")
    print(f"🐍 Python路径: {venv_python}")
    
    try:
        # 启动应用
        # subprocess.run() 用于执行外部命令
        # [str(venv_python), str(app_file)] 是要执行的命令和参数
        # - str(venv_python): 虚拟环境中的Python解释器路径
        # - str(app_file): 要运行的app.py文件路径
        # check=True: 如果命令执行失败（非零退出码），抛出CalledProcessError异常
        # 相当于在终端执行: /path/to/venv/bin/python /path/to/app.py
        subprocess.run([str(venv_python), str(app_file)], check=True)
    except subprocess.CalledProcessError as e:
        print(f"❌ 启动失败: {e}")
        sys.exit(1)
    except KeyboardInterrupt:
        print("\n👋 服务已停止")

# Python 程序的入口点
# __name__ 是 Python 的内置变量
# 当直接运行此脚本时，__name__ 的值是 "__main__"
# 当作为模块导入时，__name__ 的值是模块名（如 "start"）
# 这样可以区分脚本是直接运行还是被导入
if __name__ == "__main__":
    main()  # 只有直接运行此脚本时才执行 main() 函数
