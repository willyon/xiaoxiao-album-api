const path = require('path')
const fs = require('fs')

/** 默认：项目根下 models/multilingual-e5-small（config + tokenizer + onnx/） */
const DEFAULT_LOCAL_MODEL_DIR = path.join(__dirname, '..', '..', 'models', 'multilingual-e5-small')

/**
 * ONNX 权重基名（不含 .onnx），对应 onnx/model_uint8.onnx。
 * 可设环境变量 TEXT_EMBEDDING_ONNX_BASENAME 覆盖。
 */
const LOCAL_ONNX_MODEL_BASENAME = process.env.TEXT_EMBEDDING_ONNX_BASENAME || 'model_uint8'

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

function isLocalModelDirReady(dir) {
  if (!fs.existsSync(dir)) return false
  if (!fs.existsSync(path.join(dir, 'config.json'))) return false
  const onnxFile = path.join(dir, 'onnx', `${LOCAL_ONNX_MODEL_BASENAME}.onnx`)
  return fs.existsSync(onnxFile)
}

function assertLocalModelReady(dir) {
  if (isLocalModelDirReady(dir)) return
  const onnxRel = path.join('onnx', `${LOCAL_ONNX_MODEL_BASENAME}.onnx`)
  throw new Error(
    `[embeddingProvider] 本地文本向量模型不可用：${dir}\n` +
      `需要存在 config.json 与 ${onnxRel}。请放置 multilingual-e5-small（或等价 ONNX 布局），或设置 TEXT_EMBEDDING_LOCAL_PATH / TEXT_EMBEDDING_LOCAL_MODEL。`
  )
}

/** 当前配置的模型目录（不校验是否已就绪；就绪性在首次加载 pipeline 时检查） */
function getEmbeddingModelId() {
  return resolveModelDir()
}

let extractorPromise = null

function getPipelineOptions() {
  return {
    subfolder: 'onnx',
    model_file_name: LOCAL_ONNX_MODEL_BASENAME,
    local_files_only: true
  }
}

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

function buildEmbeddingInput(kind, text) {
  const raw = String(text || '').trim()
  if (!raw) return ''
  return kind === 'query' ? `query: ${raw}` : `passage: ${raw}`
}

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

async function generateTextEmbeddingForQuery(text) {
  return generateTextEmbedding('query', text)
}

async function generateTextEmbeddingForDocument(text) {
  return generateTextEmbedding('passage', text)
}

module.exports = {
  DEFAULT_LOCAL_MODEL_DIR,
  LOCAL_ONNX_MODEL_BASENAME,
  resolveModelDir,
  isLocalModelDirReady,
  getEmbeddingModelId,
  generateTextEmbeddingForQuery,
  generateTextEmbeddingForDocument
}
