import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ps1 = resolve(here, "ensure-whisper-model.ps1");
const sh = resolve(here, "ensure-whisper-model.sh");

const isWindows = process.platform === "win32";
const command = isWindows ? "powershell" : "bash";
const args = isWindows
  ? ["-ExecutionPolicy", "Bypass", "-File", ps1]
  : [sh];

const child = spawn(command, args, {
  stdio: "inherit",
  shell: false,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.stderr.write(`ensure-model terminated by signal: ${signal}\n`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});

child.on("error", (err) => {
  process.stderr.write(`Failed to run ensure-model: ${String(err)}\n`);
  process.exit(1);
});
