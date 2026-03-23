import express from "express";
import { v4 as uuidv4 } from "uuid";
import rateLimit from "express-rate-limit";
import { createExecution, getExecution, pool, verifyDatabaseConnection } from "./db.js";
import { installProcessHandlers, logError, logInfo, logWarn } from "./logger.js";
import { visualize } from "./visualization.js";

const app = express();
const port = Number(process.env.PORT || 8080);

installProcessHandlers("api");

app.set("trust proxy", 1);
app.use(express.json());

app.use((req, res, next) => {
  const startedAt = Date.now();

  res.on("finish", () => {
    logInfo("http_request_completed", {
      component: "api",
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
      userAgent: req.get("user-agent") || null,
      executionId: req.params.id || res.locals.executionId || null,
    });
  });

  next();
});

/* ------------------ RATE LIMIT ------------------ */
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Too many requests, slow down" },
});
app.use("/execute", limiter);

/* ------------------ EXECUTE ------------------ */
app.post("/execute", async (req, res) => {
  try {
    const { language, code, testcases, problemId, userId } = req.body;

    logInfo("execution_enqueue_requested", {
      component: "api",
      language,
      userId,
      problemId: problemId || null,
      testcaseCount: Array.isArray(testcases) ? testcases.length : null,
      codeLength: typeof code === "string" ? code.length : null,
    });

    if (!language || !code || !testcases || !userId) {
      logWarn("execution_enqueue_rejected_missing_fields", {
        component: "api",
        language: Boolean(language),
        hasCode: Boolean(code),
        hasTestcases: Boolean(testcases),
        hasUserId: Boolean(userId),
      });
      return res.status(400).json({ error: "Missing fields" });
    }

    if (code.length > 10000) {
      logWarn("execution_enqueue_rejected_code_too_large", {
        component: "api",
        userId,
        codeLength: code.length,
      });
      return res.status(400).json({ error: "Code too large" });
    }

    if (testcases.length > 50) {
      logWarn("execution_enqueue_rejected_too_many_testcases", {
        component: "api",
        userId,
        testcaseCount: testcases.length,
      });
      return res.status(400).json({ error: "Too many testcases" });
    }

    /* -------- USER RATE LIMIT -------- */
    const recent = await pool.query(
      `SELECT COUNT(*) FROM executions
       WHERE user_id = $1
       AND created_at > NOW() - INTERVAL '1 minute'`,
      [userId],
    );

    if (parseInt(recent.rows[0].count) > 20) {
      logWarn("execution_enqueue_rejected_user_rate_limit", {
        component: "api",
        userId,
        recentCount: parseInt(recent.rows[0].count),
      });
      return res.status(429).json({ error: "User rate limit exceeded" });
    }

    /* -------- SYSTEM QUEUE LIMIT -------- */
    const queued = await pool.query(
      `SELECT COUNT(*) FROM executions WHERE status IN ('queued','running')`,
    );

    if (parseInt(queued.rows[0].count) > 1000) {
      logWarn("execution_enqueue_rejected_system_busy", {
        component: "api",
        queuedCount: parseInt(queued.rows[0].count),
      });
      return res.status(503).json({ error: "System busy" });
    }

    const executionId = uuidv4();
    res.locals.executionId = executionId;

    await createExecution({
      id: executionId,
      language,
      code,
      testcases,
      problemId,
      userId,
    });

    logInfo("execution_enqueued", {
      component: "api",
      executionId,
      userId,
      language,
      problemId: problemId || null,
      testcaseCount: testcases.length,
      queuedCount: parseInt(queued.rows[0].count) + 1,
    });

    res.json({
      executionId,
      status: "queued",
    });
  } catch (err) {
    logError("execution_enqueue_failed", { component: "api", error: err });
    res.status(500).json({ error: "Internal error" });
  }
});

/* ------------------ RESULT ------------------ */
app.get("/result/:id", async (req, res) => {
  try {
    const exec = await getExecution(req.params.id);

    if (!exec) {
      logWarn("execution_result_not_found", {
        component: "api",
        executionId: req.params.id,
      });
      return res.status(404).json({ error: "Not found" });
    }

    const response = {
      executionId: exec.id,
      status: exec.status,
    };

    if (exec.status === "running") {
      response.progress = exec.progress || null;
      response.testcaseResults = exec.result?.testcaseResults || [];
    }

    if (exec.status === "completed") {
      response.result = exec.result || null;
    }

    logInfo("execution_result_fetched", {
      component: "api",
      executionId: exec.id,
      status: exec.status,
      hasProgress: Boolean(exec.progress),
      hasResult: Boolean(exec.result),
    });

    res.json(response);
  } catch (err) {
    logError("execution_result_failed", {
      component: "api",
      executionId: req.params.id,
      error: err,
    });
    res.status(500).json({ error: "Internal error" });
  }
});

app.post("/visualize", async (req, res) => {
  try {
    const { language, code, input } = req.body;

    logInfo("visualization_requested", {
      component: "api",
      language,
      codeLength: typeof code === "string" ? code.length : null,
      inputLength: typeof input === "string" ? input.length : null,
    });

    if (!language || !code) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const result = await visualize({ language, code, input });

    res.json(result);
  } catch (err) {
    logError("visualization_failed", { component: "api", error: err });
    res.status(500).json({ error: "Visualization failed" });
  }
});

/* ------------------ HEALTH ------------------ */
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "api",
    port,
  });
});

app.get("/healthz", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({
      ok: true,
      service: "api",
      port,
      hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
    });
  } catch (error) {
    logError("api_healthcheck_failed", { component: "api", error });
    res.status(500).json({
      ok: false,
      service: "api",
    });
  }
});

async function startApi() {
  logInfo("api_starting", {
    component: "api",
    port,
    hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
    nodeVersion: process.version,
    command: process.argv.join(" "),
  });

  await verifyDatabaseConnection("api_startup");

  app.listen(port, () => {
    logInfo("api_listening", {
      component: "api",
      port,
    });
  });
}

startApi().catch((error) => {
  logError("api_startup_failed", { component: "api", error });
  process.exit(1);
});
