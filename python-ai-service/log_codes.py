"""
日志代码映射文件
用于管理所有日志代码及其对应的描述信息
"""

# 代码描述映射
CODE_DESCRIPTIONS = {
    # 服务相关
    "SERVICE_START": "服务启动",
    "SERVICE_STOP": "服务停止", 
    "SERVICE_HEALTH": "健康检查",
    "SERVICE_CONFIG_ERROR": "配置错误",
    
    # 人脸识别相关
    "FACE_MODEL_LOAD": "人脸模型加载",
    "FACE_MODEL_ERROR": "人脸模型错误",
    "FACE_DET_START": "人脸检测开始",
    "FACE_DET_SUCCESS": "人脸检测成功",
    "FACE_DET_FAIL": "人脸检测失败",
    "FACE_DET_NO_FACE": "未检测到人脸",
    "FACE_DET_CONF_LOW": "置信度过低",
    "FACE_ATTR_START": "属性分析开始",
    "FACE_ATTR_SUCCESS": "属性分析成功",
    "FACE_ATTR_FAIL": "属性分析失败",
    
    # OCR相关
    "OCR_MODEL_LOAD": "OCR模型加载",
    "OCR_MODEL_ERROR": "OCR模型错误",
    "OCR_START": "OCR开始",
    "OCR_SUCCESS": "OCR成功",
    "OCR_FAIL": "OCR失败",
    "OCR_NO_TEXT": "未识别到文字",
    
    # 图像处理相关
    "IMG_LOAD": "图像加载",
    "IMG_LOAD_ERROR": "图像加载错误",
    "IMG_SIZE_ERROR": "图像尺寸错误",
    "IMG_FORMAT_ERROR": "图像格式错误",
    "IMG_PROCESS": "图像处理",
    "IMG_PROCESS_ERROR": "图像处理错误",
    
    # 内存和性能相关
    "MEMORY_LOW": "内存不足",
    "MEMORY_HIGH": "内存使用率高",
    "PERF_SLOW": "性能较慢",
    "PERF_TIMEOUT": "处理超时",
    
    # 请求相关
    "REQ_INVALID": "无效请求",
    "REQ_TIMEOUT": "请求超时",
    "REQ_RATE_LIMIT": "请求频率限制",
    
    # 数据库相关
    "DB_CONNECT": "数据库连接",
    "DB_CONNECT_ERROR": "数据库连接错误",
    "DB_QUERY": "数据库查询",
    "DB_QUERY_ERROR": "数据库查询错误",
    
    # 聚类相关
    "CLUSTER_START": "聚类开始",
    "CLUSTER_SUCCESS": "聚类成功",
    "CLUSTER_FAIL": "聚类失败",
    "CLUSTER_NO_DATA": "聚类数据不足",
}

def get_code_description(code):
    """获取代码描述"""
    return CODE_DESCRIPTIONS.get(code, "未知代码")

def get_all_codes():
    """获取所有代码列表"""
    return list(CODE_DESCRIPTIONS.keys())

def validate_code(code):
    """验证代码是否有效"""
    return code in CODE_DESCRIPTIONS
