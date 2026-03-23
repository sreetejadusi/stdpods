import { spawn } from "child_process";
import fs from "fs";

export async function runCTrace(code) {
  const dir = `/tmp/c-${Date.now()}`;
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(`${dir}/main.c`, code);

  return new Promise((resolve) => {
    const compile = spawn("clang", ["-g", "main.c", "-o", "main"], {
      cwd: dir,
    });

    compile.on("close", (code) => {
      if (code !== 0) {
        resolve({ steps: [] });
        return;
      }

      // ✅ REAL PYTHON SCRIPT FOR LLDB
      const lldbPython = `
import lldb
import json

debugger = lldb.SBDebugger.Create()
debugger.SetAsync(False)

target = debugger.CreateTarget("${dir}/main")
process = target.LaunchSimple(None, None, "${dir}")

thread = process.GetThreadAtIndex(0)

steps = []

for i in range(10):
    frame = thread.GetFrameAtIndex(0)

    line = frame.GetLineEntry().GetLine()

    locals_dict = {}

    variables = frame.GetVariables(True, True, False, True)

    for v in variables:
        locals_dict[v.GetName()] = v.GetValue()

    steps.append({
        "line": line,
        "locals": locals_dict
    })

    process.GetThreadAtIndex(0).StepInto()

print(json.dumps(steps))
`;

      fs.writeFileSync(`${dir}/trace.py`, lldbPython);

      const lldb = spawn(
        "lldb",
        ["-b", "-o", "command script import trace.py", "-o", "run", "./main"],
        { cwd: dir },
      );

      let out = "";
      let err = "";

      lldb.stdout.on("data", (d) => (out += d.toString()));
      lldb.stderr.on("data", (d) => (err += d.toString()));

      lldb.on("close", () => {
        try {
          const jsonStart = out.indexOf("[");
          const json = out.slice(jsonStart);
          const parsed = JSON.parse(json);

          resolve({ steps: parsed });
        } catch (e) {
          console.error("LLDB ERROR:", out, err);
          resolve({ steps: [] });
        }

        fs.rmSync(dir, { recursive: true, force: true });
      });
    });
  });
}
