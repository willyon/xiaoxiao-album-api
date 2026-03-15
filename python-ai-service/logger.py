#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
扩展与全局单例
管理日志、全局状态等
参考 Node服务中的logger.js 设计，提供灵活的日志记录方法
"""

import logging
import json
from datetime import datetime
from pathlib import Path
from logging.handlers import RotatingFileHandler
from log_codes import get_code_description


class CustomLogger:
    """
    自定义日志器，使用 Python 标准 logging 模块
    
    特性：
    - 按 name 分组的单例模式：相同 name 的 CustomLogger 只创建一个实例
    - 支持自定义格式：包含时间戳、级别、代码、描述等信息
    - 双输出：同时输出到控制台和文件
    - 文件轮转：自动按日期创建日志文件，支持大小轮转
    - 代码映射：支持日志代码和描述映射
    
        使用示例：
            # 创建日志器（相同 name 会返回同一实例）
            logger1 = CustomLogger("ai-service")
            logger2 = CustomLogger("ai-service")  # 返回 logger1 的同一实例
            
            # 记录日志（支持 info、warn、error 三种级别）
            logger1.info("服务启动", code="SERVICE_START", details={"port": 8000})
            logger1.warning("警告信息", code="MEMORY_LOW", details={"usage": "85%"})
            logger2.error("处理失败", code="PROCESS_FAIL", details={"error": "timeout"})
            
            # 创建不同 name 的日志器
            face_logger = CustomLogger("face-service")
            ocr_logger = CustomLogger("ocr-service")
    """
    
    # 类变量：存储已创建的实例，实现按 name 分组的单例模式
    # 键：logger 名称，值：对应的 CustomLogger 实例
    # 例如：{"ai-service": <CustomLogger实例>, "face-service": <CustomLogger实例>}
    _instances = {}
    
    # 日志级别到 logging 方法的映射
    _level_methods = {
        "error": "error",
        "warning": "warning",
        "info": "info"
    }
    
    def __new__(cls, name="ai-service"):
        """
        控制实例创建，实现单例模式
        相同 name 的 CustomLogger 只会创建一个实例
        
        Args:
            name (str): 日志器名称，用于区分不同的日志器实例
            
        Returns:
            CustomLogger: 已存在的实例或新创建的实例
        """
        # 检查是否已存在相同 name 的实例
        if name in cls._instances:
            # 直接返回已存在的实例，避免重复创建
            return cls._instances[name]
        
        # 创建新的实例
        # super().__new__(cls) 调用父类的 __new__ 方法创建对象
        instance = super().__new__(cls)
        
        # 将新实例存储到类变量中，以 name 为键
        cls._instances[name] = instance
        
        return instance
    
    def __init__(self, name="ai-service"):
        """
        初始化日志器实例
        使用 _initialized 标记避免重复初始化
        
        Args:
            name (str): 日志器名称
        """
        # 检查是否已经初始化过
        # hasattr() 检查对象是否有指定属性
        # self._initialized 标记实例是否已经完成初始化
        if hasattr(self, '_initialized') and self._initialized:
            # 如果已初始化，直接返回，避免重复执行初始化代码
            # 这很重要，因为单例模式下 __init__ 可能被多次调用
            return
            
        # 设置日志器基本属性
        self.name = name  # 日志器名称
        self.log_dir = Path("logs")  # 日志文件目录路径
        self.log_dir.mkdir(exist_ok=True)  # 创建日志目录，如果已存在则不报错
        
        # 创建 Python 标准 logging 模块的 logger 实例
        # logging.getLogger(name) 是单例的，相同 name 返回同一对象
        self.logger = logging.getLogger(name)
        self.logger.setLevel(logging.INFO)  # 设置日志级别为 INFO，显示 INFO、WARN、ERROR 级别的日志
        self.logger.propagate = False  # 不向根 logger 传播，避免与 uvicorn 等根 handler 重复打印

        # 避免重复添加处理器
        # 检查 logger 是否已经有处理器，如果没有才添加
        # 这防止了多次创建 CustomLogger 时重复添加处理器
        if not self.logger.handlers:
            self._setup_handlers()  # 设置控制台和文件处理器
        
        # 标记当前实例已完成初始化
        # 后续调用 __init__ 时会检查这个标记，避免重复初始化
        self._initialized = True
    
    def _setup_handlers(self):
        """设置日志处理器"""
        try:
            # 自定义格式器，保持原有格式风格
            formatter = logging.Formatter(
                '%(message)s',  # 只输出消息内容，格式在 _format_message 中处理
                datefmt='%Y-%m-%d %H:%M:%S'
            )
            
            # 控制台处理器
            console_handler = logging.StreamHandler()
            console_handler.setFormatter(formatter)
            self.logger.addHandler(console_handler)
            
            # 文件处理器（按日期命名，带轮转功能）
            today = datetime.now().strftime("%Y-%m-%d")
            log_file = self.log_dir / f"{today}.log"
            
            file_handler = RotatingFileHandler(
                log_file,
                maxBytes=50*1024*1024,  # 单个日志文件大小上限为50MB
                backupCount=7,  # 保留7个备份文件
                encoding='utf-8'
            )
            file_handler.setFormatter(formatter)
            self.logger.addHandler(file_handler)
            
        except Exception as e:
            print(f"Failed to setup handlers: {e}")
    
    def _safe_stringify(self, obj, max_length=4000):
        """安全地将对象转换为字符串，防止序列化异常"""
        if obj is None:
            return ""
        
        try:
            if isinstance(obj, str):
                return obj[:max_length] + ("…[truncated]" if len(obj) > max_length else "")
            
            # 尝试 JSON 序列化对象
            # json.dumps() 将 Python 对象转换为 JSON 字符串
            json_str = json.dumps(
                obj,                    # 要序列化的对象
                ensure_ascii=False,     # 允许非 ASCII 字符（如中文）正常显示，而不是 \uXXXX 格式
                default=str            # 遇到无法序列化的对象时，使用 str() 函数转换为字符串
            )
            if len(json_str) > max_length:
                return json_str[:max_length] + "…[truncated]"
            return json_str
            
        except Exception:
            try:
                return str(obj)[:max_length] + ("…[truncated]" if len(str(obj)) > max_length else "")
            except Exception:
                return "[unstringifiable]"
    
    def _format_message(self, level, message, **kwargs):
        """
        格式化日志消息
        
        Args:
            level (str): 日志级别 (info, warn, error)
            message (str): 日志消息内容
            **kwargs: 其他参数
                - code (str): 日志代码
                - details (dict): 详细信息
                - stack (str): 堆栈信息（预留）
                - request_info (dict): 请求信息（预留）
        
        Returns:
            str: 格式化后的日志消息
        """
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        
        # 基础消息
        parts = [f"[{timestamp}] [{level.upper()}]"]
        
        # 处理代码参数
        code = kwargs.get('code')
        if code:
            description = get_code_description(code)
            parts.append(f" [{code}:{description}]")
        
        # 添加主要消息
        parts.append(f" {self._safe_stringify(message)}")
        
        # 处理详细信息
        details = kwargs.get('details')
        if details:
            parts.append(f"\nDetails: {self._safe_stringify(details)}")
        
        # 预留其他字段的处理（便于未来扩展）        
        stack = kwargs.get('stack')
        if stack:
            parts.append(f"\nStack Trace: {stack}")
        
        request_info = kwargs.get('request_info')
        if request_info:
            parts.append(f"\nRequest Info: {self._safe_stringify(request_info)}")
        
        return "\n".join(parts)
    
    def _log(self, level, message, **kwargs):
        """内部日志记录方法，使用标准 logging 模块"""
        try:
            # 格式化消息，保持原有格式
            formatted_message = self._format_message(level, message, **kwargs)
            
            # 使用 logging 模块的相应方法
            # 获取对应的日志方法名，默认使用 info
            method_name = self._level_methods.get(level, "info")
            
            # 获取并调用对应的日志方法
            log_method = getattr(self.logger, method_name)
            log_method(formatted_message)
                    
        except Exception as e:
            print(f"Logger error: {e}")
    
    def error(self, message, **kwargs):
        """
        错误日志
        
        Args:
            message (str): 日志消息
            **kwargs: 其他参数
                - code (str): 日志代码
                - details (dict): 详细信息
                - stack (str): 堆栈信息
                - request_info (dict): 请求信息
        """
        self._log("error", message, **kwargs)
    
    def warning(self, message, **kwargs):
        """
        警告日志
        
        Args:
            message (str): 日志消息
            **kwargs: 其他参数（同 error 方法）
        """
        self._log("warning", message, **kwargs)
    
    def info(self, message, **kwargs):
        """
        信息日志
        
        Args:
            message (str): 日志消息
            **kwargs: 其他参数（同 error 方法）
        """
        self._log("info", message, **kwargs)

    def close(self):
        """
        关闭日志处理器
        
        关闭当前 logger 实例的所有处理器（控制台和文件处理器），
        释放相关资源（如文件句柄），并从 logger 中移除处理器。
        
        注意：
        - 关闭后，当前 logger 将不再输出任何日志
        - 不影响其他 logger 实例的处理器
        - 通常不需要手动调用，Python 会在程序结束时自动清理
        """
        try:
            # 关闭所有处理器
            # 使用 self.logger.handlers[:] 创建列表副本，避免在迭代时修改原列表
            # 如果不使用副本，在 removeHandler() 时会跳过某些处理器
            for handler in self.logger.handlers[:]:
                handler.close()              # 关闭处理器，释放资源（如文件句柄）
                self.logger.removeHandler(handler)  # 从 logger 中移除处理器
        except Exception as e:
            print(f"Failed to close logger: {e}")


# 全局日志器实例
logger = CustomLogger("ai-service")
