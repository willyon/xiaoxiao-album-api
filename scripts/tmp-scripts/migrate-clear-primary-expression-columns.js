/*
 * 迁移：清空 media 表中的 primary_expression / primary_expression_confidence 字段。
 *
 * 背景：
 * - 业务逻辑已全部改为使用 expression_tags 表示整图表情集合；
 * - primary_expression / primary_expression_confidence 不再被写入或读取，仅遗留历史数据；
 * - 本脚本仅将这两列全部置为 NULL，不修改表结构，便于后续有需要时安全删除列。
 *
 * ⚠️ 注意：
 * - 建议在停机或低流量时执行，避免长事务影响；
 * - 可安全重复执行，多次运行结果一致；
 *
 * @Usage: 在 xiaoxiao-project-service 根目录执行
 *   node scripts/tmp-scripts/migrate-clear-primary-expression-columns.js
 */

const path = require("path");

const scriptDir = path.dirname(__filename);
const projectRoot = path.resolve(scriptDir, "..", "..");
process.chdir(projectRoot);

require("dotenv").config();

const { db } = require(path.join(projectRoot, "src", "services", "database"));

function tableExists(name) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
}

function columnNames(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function migrate() {
  if (!tableExists("media")) {
    console.log("media 表不存在，跳过");
    return;
  }

  const cols = columnNames("media");
  const hasPrimaryExpression = cols.includes("primary_expression");
  const hasPrimaryExpressionConf = cols.includes("primary_expression_confidence");

  if (!hasPrimaryExpression && !hasPrimaryExpressionConf) {
    console.log("media.primary_expression / primary_expression_confidence 均不存在，跳过");
    return;
  }

  const before = db
    .prepare(
      `
      SELECT
        SUM(CASE WHEN primary_expression IS NOT NULL AND TRIM(primary_expression) != '' THEN 1 ELSE 0 END) AS expr_count,
        SUM(CASE WHEN primary_expression_confidence IS NOT NULL THEN 1 ELSE 0 END) AS conf_count
      FROM media;
    `,
    )
    .get();
  console.log(
    `迁移前：primary_expression 非空行数=${before.expr_count || 0}, primary_expression_confidence 非空行数=${before.conf_count || 0}`,
  );

  const tx = db.transaction(() => {
    if (hasPrimaryExpression && hasPrimaryExpressionConf) {
      db.prepare(
        `
        UPDATE media
        SET
          primary_expression = NULL,
          primary_expression_confidence = NULL;
      `,
      ).run();
    } else if (hasPrimaryExpression) {
      db.prepare(
        `
        UPDATE media
        SET primary_expression = NULL;
      `,
      ).run();
    } else if (hasPrimaryExpressionConf) {
      db.prepare(
        `
        UPDATE media
        SET primary_expression_confidence = NULL;
      `,
      ).run();
    }
  });

  tx();

  const after = db
    .prepare(
      `
      SELECT
        SUM(CASE WHEN primary_expression IS NOT NULL AND TRIM(primary_expression) != '' THEN 1 ELSE 0 END) AS expr_count,
        SUM(CASE WHEN primary_expression_confidence IS NOT NULL THEN 1 ELSE 0 END) AS conf_count
      FROM media;
    `,
    )
    .get();
  console.log(
    `迁移后：primary_expression 非空行数=${after.expr_count || 0}, primary_expression_confidence 非空行数=${after.conf_count || 0}`,
  );
  console.log("✅ 已清空 media.primary_expression / primary_expression_confidence 字段的历史数据");
}

migrate();

