import { spawn } from "child_process";
import fs from "fs";

export async function runJavaTrace(code) {
  const dir = `/tmp/java-${Date.now()}`;
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(`${dir}/Main.java`, code);

  return new Promise((resolve) => {
    const compile = spawn("javac", ["Main.java"], { cwd: dir });

    compile.on("close", () => {
      const jdb = spawn("jdb", ["Main"], { cwd: dir });

      let steps = [];

      jdb.stdin.write("stop in Main.main\n");
      jdb.stdin.write("run\n");

      jdb.stdout.on("data", (data) => {
        const text = data.toString();

        if (text.includes("Breakpoint hit")) {
          steps.push({
            line: extractLine(text),
            locals: extractVariables(text),
            stack: [],
            memory: {},
          });

          jdb.stdin.write("step\n");
        }
      });

      jdb.on("close", () => {
        resolve({ steps });
        fs.rmSync(dir, { recursive: true, force: true });
      });
    });
  });
}

function extractLine(text) {
  const m = text.match(/:(\d+)/);
  return m ? parseInt(m[1]) : null;
}

function extractVariables(text) {
  const vars = {};
  const lines = text.split("\n");

  lines.forEach((l) => {
    if (l.includes("=")) {
      const [k, v] = l.split("=");
      vars[k.trim()] = v.trim();
    }
  });

  return vars;
}
