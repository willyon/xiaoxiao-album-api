# scripts/deployment/ — 仅部署相关

本目录**只保留与部署直接相关**的脚本（打包上传、服务器部署、建表）。  
定时任务、批量入队、队列/Redis 运维、数据清理等见 **scripts/development/**。

---

## 脚本及作用

### 部署 Shell

| 脚本                    | 作用                                                                      | 调用方式                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **build-and-upload.sh** | 本地打包并上传：npm run build 后 rsync 上传到服务器（不执行服务器端部署） | `./scripts/deployment/build-and-upload.sh`（在项目根执行）                                                        |
| **server-deploy.sh**    | 服务器端部署：环境准备、依赖、数据清理、数据库、PM2 启停（需先上传代码）  | 在服务器上：`./scripts/deployment/server-deploy.sh`，支持 `--npm` / `--clear-data` / `--init-db` / `--rebuild-db` |
| **full-deploy.sh**      | 一键全流程：本地打包 → 上传 → SSH 执行 server-deploy.sh                   | 在项目根：`./scripts/deployment/full-deploy.sh`，参数同上                                                         |

### 部署依赖（被上述 Shell 或 npm run build 调用）

| 脚本                         | 作用                                                                                        | 调用方式                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **sanitize-env-for-dist.js** | 对 backend-dist 中的 .env 脱敏（按认证类型剔除敏感 Key）                                    | `npm run build` 在复制完 backend-dist 后调用  |
| **fix-sharp-complete.sh**    | 修复 Sharp 原生模块（server-deploy.sh --npm 时执行）                                        | 由 server-deploy.sh 调用                      |
| **rebuild-database.js**      | 删除所有业务表并按 initTableModel 重建；server-deploy.sh 的 --init-db / --rebuild-db 会调用 | `node scripts/deployment/rebuild-database.js` |

---

## 其他

- server-deploy.sh 的 `--clear-data` 会调用 **scripts/development/clear-image-data.js**。
- 定时任务、批量入队、队列与 Redis 运维等见 **scripts/development/** 及该目录下 README.md。
- **scripts/tmp-scripts/**：用于平时临时存放临时脚本（一次性排查、实验等），详见该目录下 README.md。
