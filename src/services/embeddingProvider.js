const path = require("path");
const fs = require("fs");

const REMOTE_MODEL_ID = "Xenova/multilingual-e5-small";

/** 默认：项目根下 models/multilingual-e5-small（config + tokenizer + onnx/） */
const DEFAULT_LOCAL_MODEL_DIR = path.join(__dirname, "..", "..", "models", "multilingual-e5-small");

/**
 * ONNX 权重基名（不含 .onnx），对应 onnx/model_uint8.onnx。
 * 可设环境变量 TEXT_EMBEDDING_ONNX_BASENAME 覆盖。
 */
const LOCAL_ONNX_MODEL_BASENAME = process.env.TEXT_EMBEDDING_ONNX_BASENAME || "model_uint8";

function resolveModelDir() {
  if (process.env.TEXT_EMBEDDING_LOCAL_PATH) {
    return path.resolve(process.env.TEXT_EMBEDDING_LOCAL_PATH);
  }
  if (process.env.TEXT_EMBEDDING_LOCAL_MODEL) {
    const p = process.env.TEXT_EMBEDDING_LOCAL_MODEL;
    if (path.isAbsolute(p) || p.startsWith(".")) return path.resolve(p);
    return path.join(__dirname, "..", "..", p);
  }
  return DEFAULT_LOCAL_MODEL_DIR;
}

function isLocalModelDirReady(dir) {
  if (!fs.existsSync(dir)) return false;
  if (!fs.existsSync(path.join(dir, "config.json"))) return false;
  const onnxFile = path.join(dir, "onnx", `${LOCAL_ONNX_MODEL_BASENAME}.onnx`);
  return fs.existsSync(onnxFile);
}

function getEmbeddingModelId() {
  const localDir = resolveModelDir();
  if (isLocalModelDirReady(localDir)) return localDir;
  return process.env.EMBEDDING_MODEL || REMOTE_MODEL_ID;
}

let extractorPromise = null;

function getPipelineOptions(useLocal) {
  return {
    subfolder: "onnx",
    model_file_name: LOCAL_ONNX_MODEL_BASENAME,
    local_files_only: useLocal,
  };
}

async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = import("@huggingface/transformers").then(async ({ pipeline, env }) => {
      const localDir = resolveModelDir();
      const useLocal = isLocalModelDirReady(localDir);
      const modelId = useLocal ? localDir : process.env.EMBEDDING_MODEL || REMOTE_MODEL_ID;
      env.allowRemoteModels = !useLocal;
      env.useBrowserCache = false;
      return pipeline("feature-extraction", modelId, getPipelineOptions(useLocal));
    });
  }
  return extractorPromise;
}

function buildEmbeddingInput(kind, text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  return kind === "query" ? `query: ${raw}` : `passage: ${raw}`;
}

async function generateTextEmbedding(kind, text) {
  const input = buildEmbeddingInput(kind, text);
  if (!input) return [];
  const extractor = await getExtractor();
  const output = await extractor(input, {
    pooling: "mean",
    normalize: true,
  });
  const vector = Array.from(output?.data || []);
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error("local embedding inference returned empty vector");
  }
  return vector.map((v) => Number(v) || 0);
}

async function generateTextEmbeddingForQuery(text) {
  return generateTextEmbedding("query", text);
}

async function generateTextEmbeddingForDocument(text) {
  return generateTextEmbedding("passage", text);
}

module.exports = {
  REMOTE_MODEL_ID,
  DEFAULT_LOCAL_MODEL_DIR,
  LOCAL_ONNX_MODEL_BASENAME,
  resolveModelDir,
  isLocalModelDirReady,
  getEmbeddingModelId,
  generateTextEmbeddingForQuery,
  generateTextEmbeddingForDocument,
};

Object.defineProperty(module.exports, "EMBEDDING_MODEL", {
  enumerable: true,
  get: getEmbeddingModelId,
});
