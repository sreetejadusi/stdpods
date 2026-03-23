import http from "http";
import { pool, verifyDatabaseConnection } from "./db.js";
import { runPython } from "./execution-engine.js";
import { installProcessHandlers, logError, logInfo, logWarn } from "./logger.js";

const port = Number(process.env.PORT || 8080);
const pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS || 1000);
const idleLogIntervalMs = Number(process.env.WORKER_IDLE_LOG_INTERVAL_MS || 30000);

let currentJobId = null;
let lastJobStartedAt = null;
let lastJobFinishedAt = null;
let lastSuccessfulPollAt = null;
let idleSince = Date.now();
let lastIdleLogAt = 0;

installProcessHandlers("worker");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maybeLogIdleHeartbeat() {
  const now = Date.now();

  if (now - lastIdleLogAt < idleLogIntervalMs) {
    return;
  }

  lastIdleLogAt = now;

  logInfo("worker_idle_heartbeat", {
    component: "worker",
    idleForMs: now - idleSince,
    pollIntervalMs,
    currentJobId,
    lastSuccessfulPollAt,
    hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
  });
}

async function claimJob() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const res = await client.query(`
      SELECT * FROM executions
      WHERE status = 'queued'
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);

    if (res.rows.length === 0) {
      await client.query("COMMIT");
      lastSuccessfulPollAt = new Date().toISOString();
      return null;
    }

    const job = res.rows[0];

    await client.query(
      `UPDATE executions
       SET status='running',
           progress=$1::jsonb
       WHERE id=$2`,
      [
        JSON.stringify({
          current: 0,
          total: Array.isArray(job.testcases) ? job.testcases.length : 0,
          stage: "claimed",
        }),
        job.id,
      ],
    );

    await client.query("COMMIT");
    lastSuccessfulPollAt = new Date().toISOString();

    logInfo("worker_job_claimed", {
      component: "worker",
      executionId: job.id,
      language: job.language,
      testcaseCount: Array.isArray(job.testcases) ? job.testcases.length : null,
      userId: job.user_id || null,
    });

    return job;
  } catch (error) {
    await client.query("ROLLBACK");
    logError("worker_claim_job_failed", { component: "worker", error });
    throw error;
  } finally {
    client.release();
  }
}

async function failJob(id, result) {
  await pool.query(
    `UPDATE executions
     SET status='completed',
         result=$1::jsonb
     WHERE id=$2`,
    [JSON.stringify(result), id],
  );

  logWarn("worker_job_completed_with_failure", {
    component: "worker",
    executionId: id,
    result,
  });
}

async function processJob(job) {
  const { id, code, testcases } = job;
  const safeTestcases = Array.isArray(testcases) ? testcases : [];

  currentJobId = id;
  lastJobStartedAt = new Date().toISOString();

  logInfo("worker_job_processing_started", {
    component: "worker",
    executionId: id,
    testcaseCount: safeTestcases.length,
  });

  let passed = 0;
  const total = safeTestcases.length;
  const testcaseResults = [];

  for (let i = 0; i < safeTestcases.length; i += 1) {
    const tc = safeTestcases[i];
    const testcaseNumber = i + 1;

    logInfo("worker_testcase_started", {
      component: "worker",
      executionId: id,
      testcaseNumber,
      total,
      inputLength: typeof tc.input === "string" ? tc.input.length : null,
    });

    const result = await runPython(code, tc.input, 2000, {
      executionId: id,
      testcaseNumber,
    });

    if (result.status === "Time Limit Exceeded") {
      await failJob(id, {
        status: "Time Limit Exceeded",
        failedTestCase: testcaseNumber,
      });
      return;
    }

    if (result.status === "Runtime Error") {
      await failJob(id, {
        status: "Runtime Error",
        failedTestCase: testcaseNumber,
        error: result.error,
      });
      return;
    }

    const output = result.output;

    testcaseResults.push({
      testCaseNumber: testcaseNumber,
      output,
    });

    if (output === tc.expectedOutput) {
      passed += 1;
    } else {
      await failJob(id, {
        status: "Wrong Answer",
        failedTestCase: testcaseNumber,
        expected: tc.expectedOutput,
        got: output,
      });
      return;
    }

    await pool.query(
      `UPDATE executions
       SET progress=$1::jsonb,
           result=$2::jsonb
       WHERE id=$3`,
      [
        JSON.stringify({
          current: testcaseNumber,
          total,
          stage: "running",
        }),
        JSON.stringify({
          testcaseResults,
        }),
        id,
      ],
    );

    logInfo("worker_testcase_passed", {
      component: "worker",
      executionId: id,
      testcaseNumber,
      total,
    });
  }

  await pool.query(
    `UPDATE executions
     SET status='completed',
         progress=$1::jsonb,
         result=$2::jsonb
     WHERE id=$3`,
    [
      JSON.stringify({
        current: total,
        total,
        stage: "completed",
      }),
      JSON.stringify({
        status: "Accepted",
        passed,
        total,
        testcaseResults,
      }),
      id,
    ],
  );

  logInfo("worker_job_completed_successfully", {
    component: "worker",
    executionId: id,
    passed,
    total,
  });
}

async function workerLoop() {
  while (true) {
    try {
      const job = await claimJob();

      if (!job) {
        maybeLogIdleHeartbeat();
        await sleep(pollIntervalMs);
        continue;
      }

      idleSince = Date.now();

      try {
        await processJob(job);
      } finally {
        currentJobId = null;
        lastJobFinishedAt = new Date().toISOString();
      }
    } catch (error) {
      logError("worker_loop_iteration_failed", {
        component: "worker",
        currentJobId,
        error,
      });
      await sleep(pollIntervalMs);
    }
  }
}

function startHealthServer() {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        service: "worker",
        port,
        currentJobId,
        lastJobStartedAt,
        lastJobFinishedAt,
        lastSuccessfulPollAt,
      }),
    );
  });

  server.listen(port, () => {
    logInfo("worker_health_server_listening", {
      component: "worker",
      port,
    });
  });
}

async function startWorker() {
  logInfo("worker_starting", {
    component: "worker",
    port,
    pollIntervalMs,
    idleLogIntervalMs,
    hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
    nodeVersion: process.version,
    command: process.argv.join(" "),
    cloudRunService: process.env.K_SERVICE || null,
  });

  startHealthServer();
  await verifyDatabaseConnection("worker_startup");

  logWarn("worker_cloud_run_cpu_note", {
    component: "worker",
    message:
      "This worker uses a polling loop. On Cloud Run you typically need always-allocated CPU, otherwise background polling can stall between requests.",
  });

  await workerLoop();
}

startWorker().catch((error) => {
  logError("worker_startup_failed", { component: "worker", error });
  process.exit(1);
});
