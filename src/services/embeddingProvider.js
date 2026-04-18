const path = require('path')
const fs = require('fs')

/** 默认：项目根下 models/multilingual-e5-small（config + tokenizer + onnx/） */
const DEFAULT_LOCAL_MODEL_DIR = path.join(__dirname, '..', '..', 'models', 'multilingual-e5-small')

/**
 * ONNX 权重基名（不含 .onnx），对应 onnx/model_uint8.onnx。
 * 可设环境变量 TEXT_EMBEDDING_ONNX_BASENAME 覆盖。
 */
const LOCAL_ONNX_MODEL_BASENAME = process.env.TEXT_EMBEDDING_ONNX_BASENAME || 'model_uint8'

/**
 * 解析文本向量模型目录。
 * @returns {string} 模型目录绝对路径。
 */
function resolveModelDir() {
  if (process.env.TEXT_EMBEDDING_LOCAL_PATH) {
    return path.resolve(process.env.TEXT_EMBEDDING_LOCAL_PATH)
  }
  if (process.env.TEXT_EMBEDDING_LOCAL_MODEL) {
    const p = process.env.TEXT_EMBEDDING_LOCAL_MODEL
    if (path.isAbsolute(p) || p.startsWith('.')) return path.resolve(p)
    return path.join(__dirname, '..', '..', p)
  }
  return DEFAULT_LOCAL_MODEL_DIR
}

/**
 * 检查本地模型目录是否具备最小可用文件。
 * @param {string} dir - 模型目录绝对路径。
 * @returns {boolean} 是否可用。
 */
function isLocalModelDirReady(dir) {
  if (!fs.existsSync(dir)) return false
  if (!fs.existsSync(path.join(dir, 'config.json'))) return false
  const onnxFile = path.join(dir, 'onnx', `${LOCAL_ONNX_MODEL_BASENAME}.onnx`)
  return fs.existsSync(onnxFile)
}

/**
 * 断言本地模型可用，不可用时抛错。
 * @param {string} dir - 模型目录绝对路径。
 * @returns {void} 无返回值。
 */
function assertLocalModelReady(dir) {
  if (isLocalModelDirReady(dir)) return
  const onnxRel = path.join('onnx', `${LOCAL_ONNX_MODEL_BASENAME}.onnx`)
  throw new Error(
    `[embeddingProvider] 本地文本向量模型不可用：${dir}\n` +
      `需要存在 config.json 与 ${onnxRel}。请放置 multilingual-e5-small（或等价 ONNX 布局），或设置 TEXT_EMBEDDING_LOCAL_PATH / TEXT_EMBEDDING_LOCAL_MODEL。`
  )
}

let extractorPromise = null

/**
 * 构建 transformers pipeline 初始化参数。
 * @returns {{subfolder:string,model_file_name:string,local_files_only:true}} pipeline 选项。
 */
function getPipelineOptions() {
  return {
    subfolder: 'onnx',
    model_file_name: LOCAL_ONNX_MODEL_BASENAME,
    local_files_only: true
  }
}

/**
 * 懒加载文本向量 extractor。
 * @returns {Promise<any>} extractor 实例。
 */
async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = import('@huggingface/transformers').then(async ({ pipeline, env }) => {
      const localDir = resolveModelDir()
      assertLocalModelReady(localDir)
      env.allowRemoteModels = false
      env.useBrowserCache = false
      return pipeline('feature-extraction', localDir, getPipelineOptions())
    })
  }
  return extractorPromise
}

/**
 * 构建 E5 输入文本前缀。
 * @param {'query'|'passage'} kind - 文本类型。
 * @param {string} text - 原始文本。
 * @returns {string} 带前缀输入文本。
 */
function buildEmbeddingInput(kind, text) {
  const raw = String(text || '').trim()
  if (!raw) return ''
  return kind === 'query' ? `query: ${raw}` : `passage: ${raw}`
}

/**
 * 生成文本向量。
 * @param {'query'|'passage'} kind - 文本类型。
 * @param {string} text - 原始文本。
 * @returns {Promise<number[]>} 单精度向量数组。
 */
async function generateTextEmbedding(kind, text) {
  const input = buildEmbeddingInput(kind, text)
  if (!input) return []
  const extractor = await getExtractor()
  const output = await extractor(input, {
    pooling: 'mean',
    normalize: true
  })
  const vector = Array.from(output?.data || [])
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('embedding inference returned empty vector')
  }
  return vector.map((v) => Number(v) || 0)
}

/**
 * 生成查询文本向量。
 * @param {string} text - 查询文本。
 * @returns {Promise<number[]>} 查询向量。
 */
async function generateTextEmbeddingForQuery(text) {
  return generateTextEmbedding('query', text)
}

/**
 * 生成文档文本向量。
 * @param {string} text - 文档文本。
 * @returns {Promise<number[]>} 文档向量。
 */
async function generateTextEmbeddingForDocument(text) {
  return generateTextEmbedding('passage', text)
}

module.exports = {
  generateTextEmbeddingForQuery,
  generateTextEmbeddingForDocument
}
