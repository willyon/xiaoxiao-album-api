# macOS 环境下安装 InsightFace 0.7.3 指南

适用于 `macOS (Apple Silicon)` + `Python 3.11`。InsightFace 官方目前未提供对应的预编译 wheel，`pip` 会触发源码构建并依赖系统的标准 C++ 头文件。若不额外处理，常见报错为：

```
fatal error: 'cmath' file not found
error: command '/usr/bin/clang++' failed with exit code 1
```

## 安装步骤

1. **确保已安装 Apple Command Line Tools**

   ```bash
   xcode-select --install
   ```

   若已安装可忽略。

2. **设置必需的环境变量后安装**

   ```bash
   export SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk
   export CXXFLAGS="-I${SDKROOT}/usr/include/c++/v1"
   pip install insightface==0.7.3
   ```

   - `SDKROOT` 指向 macOS SDK，确保 clang 能找到系统头文件。
   - `CXXFLAGS` 追加 libc++ 头文件目录，避免缺少 `cmath` 等标准头。

3. **虚拟环境安装实例**

   ```bash
   python3.11 -m venv venv
   source venv/bin/activate
   pip install -U pip setuptools wheel
   export SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk
   export CXXFLAGS="-I${SDKROOT}/usr/include/c++/v1"
   pip install insightface==0.7.3
   ```

## 常见问题

- **仍提示缺少头文件？**  
  检查 `SDKROOT` 是否指向真实存在的 SDK（可通过 `ls /Library/Developer/CommandLineTools/SDKs` 查看），必要时改用具体版本如 `MacOSX15.sdk`。

- **其它依赖安装失败**  
  在同一终端会话中继续安装，保持上述两个环境变量不变即可。

- **是否影响项目其他功能？**  
  仅用于 InsightFace 编译；安装完成后可按需取消导出的环境变量，不会影响已经构建成功的 wheel。
