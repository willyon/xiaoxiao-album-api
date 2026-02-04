<!--
 * @Author: zhangshouchang
 * @Date: 2024-08-28 09:35:32
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-09-17 21:29:53
 * @Description: File description
-->

# My Node.js Project

node 脚本.js 命令的执行一定要在根目录下。

---

## 脚本目录说明

| 目录 | 用途 | 何时用 |
|------|------|--------|
| **scripts/development/** | 开发与日常运维 | 队列重试/清空、Redis 清理、PM2 定时任务（相似图/人脸聚类全量重建）、批量入队（AI/清理）、数据清理（clear-image-data）等 |
| **scripts/deployment/** | 仅部署相关 | 构建（`npm run build` 会调用）、部署 shell（打包上传、服务器部署、一键部署）、建表（rebuild-database）、fix-sharp |

两个子目录均配有 **README.md**，内有脚本列表和调用方式。
