import { spawn } from "child_process";
import { runCTrace } from "./c-tracer.js";
import { runJavaTrace } from "./java-tracer.js";
import { logError, logInfo } from "./logger.js";

const PYTHON_VISUALIZER_TIMEOUT_MS = Number(
  process.env.PYTHON_VISUALIZER_TIMEOUT_MS || 5000,
);

function normalize(steps) {
  if (!Array.isArray(steps)) {
    steps = [];
  }

  return {
    steps: steps.map((step) => ({
      event: step.event || "line",
      line: step.line ?? null,
      globals: step.globals || {},
      stack: step.stack || [],
      memory: step.memory || {},
      stdout: step.stdout || "",
      exception: step.exception || null,
      return: step.return ?? null,
      locals:
        step.locals ||
        step.stack?.[step.stack.length - 1]?.locals ||
        {},
    })),
  };
}

export async function runPythonTrace(code, input = "") {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const proc = spawn("python3", ["python-visualizer.py"]);
    const payload = JSON.stringify({ code, input });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) {
        return;
      }

      finished = true;
      proc.kill("SIGKILL");

      logError("python_visualization_timed_out", {
        component: "visualization",
        durationMs: Date.now() - startedAt,
        timeoutMs: PYTHON_VISUALIZER_TIMEOUT_MS,
      });

      resolve([]);
    }, PYTHON_VISUALIZER_TIMEOUT_MS);

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("close", () => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timer);

      try {
        const parsed = JSON.parse(stdout);
        const trace = Array.isArray(parsed.trace) ? parsed.trace : [];

        logInfo("python_visualization_succeeded", {
          component: "visualization",
          durationMs: Date.now() - startedAt,
          stepCount: trace.length,
        });

        resolve(trace);
      } catch (error) {
        logError("python_visualization_parse_failed", {
          component: "visualization",
          durationMs: Date.now() - startedAt,
          error,
          rawStdout: stdout,
          rawStderr: stderr,
        });
        resolve([]);
      }
    });

    proc.on("error", (error) => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timer);

      logError("python_visualization_process_failed", {
        component: "visualization",
        durationMs: Date.now() - startedAt,
        error,
      });

      resolve([]);
    });

    proc.stdin.write(payload);
    proc.stdin.end();
  });
}

export async function visualize({ language, code, input }) {
  let steps = [];

  logInfo("visualization_started", {
    component: "visualization",
    language,
    codeLength: typeof code === "string" ? code.length : null,
    inputLength: typeof input === "string" ? input.length : null,
  });

  if (language === "python") {
    steps = await runPythonTrace(code, input);
  } else if (language === "c") {
    const result = await runCTrace(code);
    steps = result.steps || [];
  } else if (language === "java") {
    const result = await runJavaTrace(code);
    steps = result.steps || [];
  } else {
    throw new Error("Unsupported language");
  }

  return normalize(steps);
}
