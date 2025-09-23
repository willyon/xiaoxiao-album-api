# 后端部署指南

## 🚀 部署方式

### 方式一：分离式部署（推荐）

将部署分为两个步骤，避免密码输入问题：

#### 1. 本地执行（打包上传）

```bash
# 在 xiaoxiao-project-service 目录下执行

# 打包和上传（无参数）
./deployment-scripts/deploy-local.sh
```

#### 2. 服务器执行（环境准备和服务管理）

```bash
# SSH到服务器
ssh -i /path/to/key.pem xiaoxiao@8.134.118.242
cd /var/www/photos.bingbingcloud.com/backend

# 执行服务器部署脚本（根据本地脚本提示的参数）
./deploy-server.sh

# 或者带参数执行
./deploy-server.sh --force-npm
./deploy-server.sh --clear-data
./deploy-server.sh --force-npm --clear-data
```

### 方式二：一体化部署（传统方式）

```bash
# 在 xiaoxiao-project-service 目录下执行

# 智能部署（默认，推荐）
./deployment-scripts/deploy-complete.sh

# 强制重新安装npm依赖
./deployment-scripts/deploy-complete.sh --force-npm

# 跳过npm依赖安装（快速部署）
./deployment-scripts/deploy-complete.sh --skip-npm

# 清理所有数据后部署（开发测试环境）
./deployment-scripts/deploy-complete.sh --clear-data

# 组合使用
./deployment-scripts/deploy-complete.sh --clear-data --force-npm

# 查看帮助
./deployment-scripts/deploy-complete.sh --help
```

### 部署方式对比

#### 分离式部署的优势：

- ✅ **避免密码输入问题**：本地脚本不需要sudo权限
- ✅ **更好的错误处理**：可以在服务器上直接看到详细错误信息
- ✅ **更灵活的控制**：可以分别控制本地和服务器操作
- ✅ **更好的调试**：服务器操作可以单独调试
- ✅ **支持交互式操作**：服务器脚本支持密码输入
- ✅ **手动控制**：可以手动选择何时执行服务器部署
- ✅ **参数传递**：本地脚本会显示服务器部署所需的参数

#### 一体化部署的特点：

- ⚠️ **密码输入问题**：需要手动输入sudo密码
- ⚠️ **错误处理复杂**：远程执行时错误信息可能不清晰
- ✅ **一键完成**：所有操作在一个脚本中完成

### 参数说明

- **默认模式**：智能检查npm依赖，只安装需要的，保留现有数据
- **`--force-npm`**：强制重新安装npm依赖
- **`--skip-npm`**：跳过npm依赖安装，只更新代码和重启服务
- **`--clear-data`**：清理所有数据（数据库、文件、队列）后部署

### 脚本功能

这个脚本会自动完成以下所有步骤：

1. **📦 本地打包**
   - 执行 `npm run build`
   - 打包到 `backend-dist/` 目录
   - 包含：源代码、配置文件、服务器工具脚本（fix-sharp-complete.sh, rebuild-database.js, clearAllAboutImageData.js）
   - 不包含：本地部署脚本（deploy-complete.sh）
   - 检查必要文件是否存在

2. **📤 文件上传**
   - 上传打包后的代码到服务器（包含所有必要文件，包括.env）
   - 设置脚本执行权限

3. **🛠️ 服务器环境准备**
   - 创建必要的目录结构
   - 检查并安装Redis服务
   - 启动Redis服务

4. **📦 依赖安装**
   - 清理npm缓存并安装生产依赖
   - 检查并安装PM2进程管理器（全局安装）
   - 执行Sharp修复脚本（从源码编译以支持HEIC格式）

5. **🗑️ 数据清理（可选）**
   - 仅在 `--clear-data` 参数时执行
   - 清理数据库和文件（clearAllAboutImageData.js）
   - 清理队列任务（clearQueues.js）

6. **🗄️ 数据库初始化**
   - 执行数据库重建脚本（deployment-scripts/rebuild-database.js）
   - 创建数据库表（users, images）
   - 创建必要索引

7. **🚀 服务管理**
   - 停止现有服务
   - 启动新服务
   - 保存PM2配置

8. **🧪 部署验证**
   - 检查服务状态
   - 测试API接口

### 注意事项

- **密码输入**：脚本会在需要sudo权限时提醒你手动输入密码
- **错误处理**：遇到错误会立即停止并显示错误信息
- **数据保护**：默认情况下会保留现有数据（数据库、文件、队列）
- **数据清理**：使用 `--clear-data` 参数会清空所有数据，请谨慎使用
- **智能修复**：Sharp模块只有在需要时才会重新安装

### 核心脚本

#### 1. 完整部署脚本 (`deploy-complete.sh`)

```bash
# 一键完整部署
./deploy-complete.sh
```

**功能：**

- 本地代码打包
- 文件上传到服务器
- Redis服务安装
- Sharp模块修复（包含系统库安装）
- 数据库初始化
- 服务启动和配置

#### 2. Sharp修复脚本 (`fix-sharp-complete.sh`)

```bash
# 完整修复Sharp模块
./fix-sharp-complete.sh
```

**功能：**

- 安装Sharp编译所需的系统库
- 重新编译Sharp模块
- 验证修复结果

#### 3. 数据库重建脚本 (`rebuild-database.js`)

```bash
# 重建数据库表
node rebuild-database.js
```

**功能：**

- 创建users表
- 创建images表
- 创建必要索引

#### 4. 数据清理脚本 (`clearAllAboutImageData.js`)

```bash
# 清理所有图片相关数据
node scripts/clearAllAboutImageData.js
```

**功能：**

- 清空数据库images表
- 清空本地存储文件
- 清空OSS存储文件
- 清空Redis缓存

#### 5. 队列清理脚本 (`clearQueues.js`)

```bash
# 清理所有队列任务
node scripts/clearQueues.js
```

**功能：**

- 清空图片上传队列
- 清空图片元数据队列
- 显示清理统计信息

### 手动操作

如果需要单独执行某个步骤：

```bash
# 上传文件到服务器
scp -i /path/to/key.pem rebuild-database.js xiaoxiao@server:/var/www/photos.bingbingcloud.com/backend/

# 在服务器上执行数据库初始化
ssh -i /path/to/key.pem xiaoxiao@server "cd /var/www/photos.bingbingcloud.com/backend && node rebuild-database.js"

# 在服务器上修复Sharp（包含系统库安装）
ssh -i /path/to/key.pem xiaoxiao@server "cd /var/www/photos.bingbingcloud.com/backend && ./fix-sharp-complete.sh"

# 清理所有数据（数据库、文件、队列）
ssh -i /path/to/key.pem xiaoxiao@server "cd /var/www/photos.bingbingcloud.com/backend && node scripts/clearAllAboutImageData.js"

# 清理队列任务
ssh -i /path/to/key.pem xiaoxiao@server "cd /var/www/photos.bingbingcloud.com/backend && node scripts/clearQueues.js"

# 检查服务状态
ssh -i /path/to/key.pem xiaoxiao@server "pm2 status"

# 查看服务日志
ssh -i /path/to/key.pem xiaoxiao@server "pm2 logs"
```

### 故障排除

1. **Sharp模块问题**

   ```bash
   # 手动修复Sharp（包含系统库安装）
   ssh -i /path/to/key.pem xiaoxiao@server "cd /var/www/photos.bingbingcloud.com/backend && ./fix-sharp-complete.sh"
   ```

2. **Redis服务问题**

   ```bash
   # 检查Redis状态
   ssh -i /path/to/key.pem xiaoxiao@server "sudo systemctl status redis-server"

   # 重启Redis
   ssh -i /path/to/key.pem xiaoxiao@server "sudo systemctl restart redis-server"
   ```

3. **数据库问题**

   ```bash
   # 重新初始化数据库
   ssh -i /path/to/key.pem xiaoxiao@server "cd /var/www/photos.bingbingcloud.com/backend && node rebuild-database.js"
   ```

4. **服务问题**

   ```bash
   # 重启所有服务
   ssh -i /path/to/key.pem xiaoxiao@server "cd /var/www/photos.bingbingcloud.com/backend && pm2 restart all"
   ```

5. **数据清理问题**

   ```bash
   # 清理所有数据（开发测试环境）
   ssh -i /path/to/key.pem xiaoxiao@server "cd /var/www/photos.bingbingcloud.com/backend && node scripts/clearAllAboutImageData.js"

   # 清理队列任务
   ssh -i /path/to/key.pem xiaoxiao@server "cd /var/www/photos.bingbingcloud.com/backend && node scripts/clearQueues.js"
   ```

## 📊 PM2 服务管理

### 常用命令

#### 服务状态管理

```bash
# 查看所有服务状态
pm2 status

# 启动服务
pm2 start ecosystem.config.js

# 停止服务
pm2 stop all
pm2 stop xiaoxiao-api

# 重启服务
pm2 restart all
pm2 restart xiaoxiao-api

# 删除服务
pm2 delete all
pm2 delete xiaoxiao-api

# 重新加载服务（零停机时间）
pm2 reload all
pm2 reload xiaoxiao-api
```

#### 日志查看

```bash
# 查看所有服务日志
pm2 logs

# 查看特定服务日志
pm2 logs xiaoxiao-api
pm2 logs image-upload-worker

# 实时查看日志（默认就是实时模式）
pm2 logs

# 查看错误日志
pm2 logs --err

# 清空日志
pm2 flush
pm2 flush xiaoxiao-api
```

#### 监控和性能

```bash
# 实时监控
pm2 monit

# 查看详细信息
pm2 show xiaoxiao-api

# 查看进程信息
pm2 list
```

#### 配置管理

```bash
# 保存当前配置
pm2 save

# 恢复保存的配置
pm2 resurrect

# 设置开机自启
pm2 startup
```

### 日志文件位置

```bash
# PM2 日志目录
~/.pm2/logs/

# 具体日志文件
~/.pm2/logs/xiaoxiao-api-out.log      # 标准输出
~/.pm2/logs/xiaoxiao-api-error.log    # 错误输出
~/.pm2/logs/image-upload-worker-out.log
~/.pm2/logs/image-upload-worker-error.log
~/.pm2/logs/image-meta-worker-out.log
~/.pm2/logs/image-meta-worker-error.log
```

### 远程管理命令

```bash
# 通过 SSH 查看服务状态
ssh -i /path/to/key.pem user@server 'pm2 status'

# 通过 SSH 查看日志
ssh -i /path/to/key.pem user@server 'pm2 logs'

# 通过 SSH 重启服务
ssh -i /path/to/key.pem user@server 'pm2 restart all'

# 通过 SSH 查看特定服务日志
ssh -i /path/to/key.pem user@server 'pm2 logs xiaoxiao-api'
```

### 部署过程日志

部署脚本会同时输出到终端和保存到日志文件：

#### 终端输出

- 📦 打包进度
- 📤 上传状态
- 🛠️ 环境准备
- 📦 依赖安装
- 🗄️ 数据库初始化
- 🚀 服务启动

#### 日志文件

- 📄 自动创建：`deployment-YYYYMMDD-HHMMSS.log`
- 📍 位置：运行脚本的当前目录
- 💾 内容：完整的部署过程记录
- 🔍 用途：即使关闭终端也能查看部署历史

#### 查看日志

```bash
# 查看最新部署日志
ls -la deployment-*.log | tail -1

# 查看日志内容
cat deployment-20241201-143022.log

# 实时查看日志（如果部署还在进行）
tail -f deployment-20241201-143022.log
```

#### 日志管理

```bash
# 清理旧日志（保留最近10个）
ls -t deployment-*.log | tail -n +11 | xargs rm -f

# 压缩旧日志
gzip deployment-*.log
```

## 🗄️ 数据库管理

### 本地数据库管理

#### 使用内置数据库管理工具

```bash
# 查看所有表
npm run db tables

# 查看用户数据（最近10条）
npm run db users

# 查看用户数据（最近20条）
npm run db users 20

# 查看图片数据
npm run db images

# 统计记录数
npm run db count users
npm run db count images

# 查看表结构
npm run db schema users
npm run db schema images

# 执行自定义查询
npm run db query "SELECT * FROM users WHERE email LIKE '%@gmail.com'"

# 查看帮助
npm run db help
```

### 远程数据库访问

#### 方法1：SSH + SQLite 命令行

```bash
# 连接到服务器
ssh -i /path/to/key.pem xiaoxiao@8.134.118.242

# 进入项目目录
cd /var/www/photos.bingbingcloud.com/backend

# 打开数据库
sqlite3 database.db

# SQLite 命令示例
.tables                    # 显示所有表
.schema users             # 显示表结构
SELECT * FROM users LIMIT 5;  # 查询数据
.quit                     # 退出
```

#### 方法2：直接执行 SQL 命令

```bash
# 查看所有表
ssh -i /path/to/key.pem xiaoxiao@8.134.118.242 "cd /var/www/photos.bingbingcloud.com/backend && sqlite3 database.db '.tables'"

# 查询用户数据
ssh -i /path/to/key.pem xiaoxiao@8.134.118.242 "cd /var/www/photos.bingbingcloud.com/backend && sqlite3 database.db 'SELECT * FROM users LIMIT 5;'"

# 统计记录数
ssh -i /path/to/key.pem xiaoxiao@8.134.118.242 "cd /var/www/photos.bingbingcloud.com/backend && sqlite3 database.db 'SELECT COUNT(*) FROM users;'"
```

#### 方法3：下载数据库文件到本地

```bash
# 下载数据库文件
scp -i /path/to/key.pem xiaoxiao@8.134.118.242:/var/www/photos.bingbingcloud.com/backend/database.db ./database.db

# 使用本地工具打开
# DB Browser for SQLite: https://sqlitebrowser.org/
# 或使用命令行
sqlite3 database.db
```

### 图形化数据库客户端

#### 推荐工具

1. **DB Browser for SQLite** (免费)
   - 下载：https://sqlitebrowser.org/
   - 支持：macOS、Windows、Linux
   - 功能：可视化查询、数据编辑、表结构查看

2. **DBeaver** (免费)
   - 下载：https://dbeaver.io/
   - 支持：多种数据库类型
   - 功能：强大的查询和数据分析

3. **SQLiteStudio** (免费)
   - 下载：https://sqlitestudio.pl/
   - 功能：轻量级 SQLite 管理工具

### 数据库备份

#### 自动备份脚本

```bash
# 创建备份
ssh -i /path/to/key.pem xiaoxiao@8.134.118.242 "cd /var/www/photos.bingbingcloud.com/backend && cp database.db database-$(date +%Y%m%d-%H%M%S).backup.db"

# 下载备份到本地
scp -i /path/to/key.pem xiaoxiao@8.134.118.242:/var/www/photos.bingbingcloud.com/backend/database-*.backup.db ./
```

## 🗑️ 数据清理指南

### 清理场景

数据清理通常在以下场景中使用：

- **开发测试环境**：重置测试数据
- **部署前清理**：清空旧数据重新开始
- **故障排除**：清理损坏的数据
- **性能优化**：清理大量测试数据

### 清理方式

#### 1. 使用部署脚本清理

```bash
# 清理所有数据后部署
./deployment-scripts/deploy-complete.sh --clear-data
```

#### 2. 手动清理

```bash
# 清理数据库和文件
ssh -i /path/to/key.pem xiaoxiao@server "cd /var/www/photos.bingbingcloud.com/backend && node scripts/clearAllAboutImageData.js"

# 清理队列任务
ssh -i /path/to/key.pem xiaoxiao@server "cd /var/www/photos.bingbingcloud.com/backend && node scripts/clearQueues.js"
```

### 清理内容

#### clearAllAboutImageData.js 清理内容：

- **数据库**：清空 `images` 表
- **本地文件**：清空 `localStorage/` 目录下的所有图片
- **OSS文件**：清空阿里云OSS中的图片文件
- **Redis缓存**：清空用户图片哈希集合

#### clearQueues.js 清理内容：

- **上传队列**：清空图片上传队列的所有任务
- **元数据队列**：清空图片元数据队列的所有任务

### 注意事项

⚠️ **重要提醒**：

- 数据清理是**不可逆**操作
- 生产环境请**谨慎使用**
- 建议在清理前**备份重要数据**
- 清理后需要**重新注册账号**

### 数据保护

默认情况下，部署脚本会保护以下数据：

- `database.db` - 用户账号数据
- `localStorage/` - 本地图片文件
- `logs/` - 日志文件

这些文件不会被 `rsync --delete` 删除。
