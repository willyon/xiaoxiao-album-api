const Database = require("better-sqlite3");
const db = new Database("database.db");

const initialzeTables = require("./db/index");
initialzeTables(db);

module.exports = db;
