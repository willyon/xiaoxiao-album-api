const js = require('@eslint/js')
const globals = require('globals')
const eslintConfigPrettier = require('eslint-config-prettier')

module.exports = [
  // 全局忽略：依赖目录、构建产物、运行时数据目录、Python 子项目
  {
    ignores: ['node_modules/**', 'backend-dist/**', 'logs/**', 'storage-local/**', 'python-ai-service/**']
  },
  // ESLint 官方推荐规则（JS 基础问题）
  js.configs.recommended,
  // 仅作用于后端 JS/CJS 文件
  {
    files: ['**/*.{js,cjs}'],
    languageOptions: {
      // 语法版本：跟随最新 ECMAScript
      ecmaVersion: 'latest',
      // 后端主要使用 CommonJS（require/module.exports）
      sourceType: 'commonjs',
      globals: {
        // 注入 Node 运行时全局变量（process、Buffer 等）
        ...globals.node
      }
    },
    rules: {
      // 未使用变量先按 warning 处理；下划线前缀视为有意占位
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_'
        }
      ],
      // 后端保留 console 输出（日志/排障常用）
      'no-console': 'off',
      // 以下规则按当前代码风格放宽，避免一次性引入大量历史噪音
      'no-useless-catch': 'off',
      'no-unsafe-optional-chaining': 'off',
      'no-control-regex': 'off',
      'no-case-declarations': 'off',
      'no-empty': 'off',
      'no-loss-of-precision': 'off',
      'no-extra-boolean-cast': 'off'
    }
  },
  // 关闭与 Prettier 冲突的格式规则
  eslintConfigPrettier
]
