import { spawn } from "child_process";
import { runCTrace } from "./c-tracer.js";
import { runJavaTrace } from "./java-tracer.js";
import { logError, logInfo } from "./logger.js";

/* ------------------ PYTHON ------------------ */

export async function runPythonTrace(code) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const proc = spawn("python3", [
      "-c",
      `
import sys, json, base64, io

trace = []

def safe(obj):
    try:
        return str(obj)
    except:
        return "<unserializable>"

def tracer(frame, event, arg):
    if event == "line":
        locals_clean = {
            k: safe(v)
            for k, v in frame.f_locals.items()
            if k != "__builtins__"
        }

        trace.append({
            "line": frame.f_lineno - START_LINE,
            "locals": locals_clean
        })
    return tracer

# capture stdout
real_stdout = sys.stdout
sys.stdout = io.StringIO()

encoded = sys.stdin.read()
user_code = base64.b64decode(encoded).decode("utf-8")

# wrap code so we can control line offset
wrapper = "def __run():\\n"
for line in user_code.split("\\n"):
    wrapper += "    " + line + "\\n"

START_LINE = 1

namespace = {}
exec(wrapper, namespace)

sys.settrace(tracer)

try:
    namespace["__run"]()
except Exception as e:
    trace.append({"error": str(e)})

sys.settrace(None)

output = sys.stdout.getvalue()
sys.stdout = real_stdout

print(json.dumps({
    "trace": trace,
    "stdout": output
}))
`,
    ]);

    let out = "";
    let err = "";

    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));

    const encoded = Buffer.from(code).toString("base64");
    proc.stdin.write(encoded);
    proc.stdin.end();

    proc.on("close", () => {
      try {
        const parsed = JSON.parse(out);
        logInfo("python_visualization_succeeded", {
          component: "visualization",
          durationMs: Date.now() - startedAt,
          stepCount: Array.isArray(parsed.trace) ? parsed.trace.length : 0,
        });
        resolve(parsed.trace || []);
      } catch (e) {
        logError("python_visualization_parse_failed", {
          component: "visualization",
          durationMs: Date.now() - startedAt,
          error: e,
          rawStdout: out,
          rawStderr: err,
        });
        resolve([]);
      }
    });
  });
}

/* ------------------ NORMALIZER ------------------ */
function normalize(steps) {
  if (!Array.isArray(steps)) steps = [];

  return {
    steps: steps.map((s) => ({
      line: s.line || null,
      locals: s.locals || {},
      globals: s.globals || {},
      stack: s.stack || [],
      memory: s.memory || {},
      stdout: s.stdout || "",
    })),
  };
}

/* ------------------ MAIN ------------------ */
export async function visualize({ language, code }) {
  let steps = [];

  logInfo("visualization_started", {
    component: "visualization",
    language,
    codeLength: typeof code === "string" ? code.length : null,
  });

  if (language === "python") {
    steps = await runPythonTrace(code); // already array
  } else if (language === "c") {
    const res = await runCTrace(code);
    steps = res.steps || [];
  } else if (language === "java") {
    const res = await runJavaTrace(code);
    steps = res.steps || [];
  } else {
    throw new Error("Unsupported language");
  }

  return normalize(steps);
}
