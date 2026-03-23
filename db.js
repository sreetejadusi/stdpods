import pkg from "pg";
import { logError, logInfo, redactDatabaseUrl } from "./logger.js";

const { Pool } = pkg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

logInfo("database_pool_created", {
  component: "db",
  databaseUrl: redactDatabaseUrl(process.env.DATABASE_URL),
  hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
});

pool.on("connect", () => {
  logInfo("database_client_connected", { component: "db" });
});

pool.on("error", (error) => {
  logError("database_pool_error", { component: "db", error });
});

/* ------------------ CREATE ------------------ */
export async function createExecution({
  id,
  language,
  code,
  testcases,
  problemId,
  userId,
}) {
  await pool.query(
    `INSERT INTO executions (id, language, code, testcases, status, result, user_id, problem_id)
     VALUES ($1,$2,$3,$4::jsonb,'queued',$5::jsonb,$6,$7)`,
    [
      id,
      language,
      code,
      JSON.stringify(testcases),
      JSON.stringify({ testcaseResults: [] }),
      userId,
      problemId,
    ],
  );
}

/* ------------------ GET ------------------ */
export async function getExecution(id) {
  const res = await pool.query(`SELECT * FROM executions WHERE id=$1`, [id]);
  return res.rows[0];
}

/* ------------------ CLAIM ------------------ */
export async function claimJob() {
  const res = await pool.query(`
    UPDATE executions
    SET status='running'
    WHERE id = (
      SELECT id FROM executions
      WHERE status='queued'
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
  `);
  return res.rows[0];
}

/* ------------------ UPDATE ------------------ */
export async function updateExecution(id, data) {
  await pool.query(
    `UPDATE executions
     SET status=$1, progress=$2::jsonb, result=$3::jsonb
     WHERE id=$4`,
    [
      data.status,
      JSON.stringify(data.progress),
      JSON.stringify(data.result),
      id,
    ],
  );
}

export async function verifyDatabaseConnection(context = "startup") {
  const start = Date.now();
  await pool.query("SELECT 1");
  logInfo("database_ping_succeeded", {
    component: "db",
    context,
    durationMs: Date.now() - start,
  });
}
