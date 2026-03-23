import { spawn } from "child_process";
import fs from "fs";
import { logError, logInfo, logWarn } from "./logger.js";

/* ------------------ PYTHON EXECUTION ------------------ */
export function runPython(code, input = "", timeoutMs = 2000, context = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const dir = `/tmp/py-${Date.now()}`;
    fs.mkdirSync(dir, { recursive: true });

    const filePath = `${dir}/main.py`;
    fs.writeFileSync(filePath, code);

    const proc = spawn("python3", [filePath]);

    logInfo("python_execution_started", {
      component: "execution-engine",
      executionId: context.executionId || null,
      testcaseNumber: context.testcaseNumber || null,
      timeoutMs,
      inputLength: input.length,
      codeLength: code.length,
      tempDir: dir,
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        proc.kill("SIGKILL");
        cleanup(dir);
        logWarn("python_execution_timed_out", {
          component: "execution-engine",
          executionId: context.executionId || null,
          testcaseNumber: context.testcaseNumber || null,
          durationMs: Date.now() - startedAt,
        });
        resolve({ status: "Time Limit Exceeded" });
      }
    }, timeoutMs);

    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });

    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    proc.on("close", () => {
      if (finished) return;

      finished = true;
      clearTimeout(timer);

      cleanup(dir);

      if (stderr && stderr.trim()) {
        logWarn("python_execution_runtime_error", {
          component: "execution-engine",
          executionId: context.executionId || null,
          testcaseNumber: context.testcaseNumber || null,
          durationMs: Date.now() - startedAt,
          error: stderr.trim(),
        });
        resolve({
          status: "Runtime Error",
          error: stderr.trim(),
        });
      } else {
        logInfo("python_execution_succeeded", {
          component: "execution-engine",
          executionId: context.executionId || null,
          testcaseNumber: context.testcaseNumber || null,
          durationMs: Date.now() - startedAt,
          outputLength: stdout.trim().length,
        });
        resolve({
          status: "Success",
          output: stdout.trim(),
        });
      }
    });

    proc.on("error", (err) => {
      if (finished) return;

      finished = true;
      clearTimeout(timer);

      cleanup(dir);

      logError("python_execution_spawn_error", {
        component: "execution-engine",
        executionId: context.executionId || null,
        testcaseNumber: context.testcaseNumber || null,
        durationMs: Date.now() - startedAt,
        error: err,
      });

      resolve({
        status: "Runtime Error",
        error: err.message,
      });
    });

    // ✅ IMPORTANT
    if (input) {
      proc.stdin.write(input);
    }

    proc.stdin.end();
  });
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}
