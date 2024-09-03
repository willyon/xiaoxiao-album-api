/*
 * @Author: zhangshouchang
 * @Date: 2024-08-28 09:24:56
 * @LastEditors: zhangshouchang
 * @LastEditTime: 2024-08-28 09:25:15
 * @Description: File description
 */
const fs = require("fs");
const path = require("path");

// 定义项目结构
const projectStructure = {
  src: {
    controllers: {},
    models: {},
    routes: {},
    services: {},
    middlewares: {},
    config: {},
    utils: {},
    "app.js": "// Application entry point\n",
    "server.js": "// Server entry point\n",
  },
  public: {},
  tests: {},
  ".gitignore": "node_modules/\n.env\n",
  "README.md": "# My Node.js Project\n",
  ".env": "# Environment variables\n",
  "package.json": JSON.stringify(
    {
      name: "my-node-project",
      version: "1.0.0",
      main: "src/server.js",
      scripts: {
        start: "node src/server.js",
        dev: "nodemon src/server.js",
      },
      dependencies: {},
      devDependencies: {},
    },
    null,
    2
  ),
};

// 递归创建文件和文件夹
function createStructure(base, structure) {
  Object.entries(structure).forEach(([key, value]) => {
    const fullPath = path.join(base, key);
    if (typeof value === "string") {
      // 创建文件并写入内容
      fs.writeFileSync(fullPath, value, "utf8");
      console.log(`Created file: ${fullPath}`);
    } else {
      // 创建文件夹并递归调用
      if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath);
        console.log(`Created directory: ${fullPath}`);
      }
      createStructure(fullPath, value);
    }
  });
}

// 创建项目结构
createStructure(__dirname, projectStructure);

console.log("Project structure created successfully!");
