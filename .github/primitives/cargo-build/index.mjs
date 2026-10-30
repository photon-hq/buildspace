import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { input, main, output } from "../runtime.mjs";

export async function cargoBuild({ binary, package: packageName = "", target = "", directory = "." }) {
  const args = ["build", "--release", "--bin", binary, "--message-format=json-render-diagnostics"];
  if (target) args.push("--target", target);
  if (packageName) args.push("--package", packageName);
  const child = spawn("cargo", args, { cwd: directory, stdio: ["ignore", "pipe", "inherit"] });
  let launchError;
  child.on("error", (error) => { launchError = error; });
  const completion = new Promise((done) => child.on("close", (code) => done(code ?? 1)));
  let binaryPath;
  for await (const line of createInterface({ input: child.stdout })) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(`${line}\n`);
      continue;
    }
    if (message.reason === "compiler-artifact" && message.target.name === binary && message.executable) binaryPath = message.executable;
  }
  const code = await completion;
  if (launchError) throw launchError;
  if (code !== 0) {
    const error = new Error(`cargo build failed with exit code ${code}`);
    error.exitCode = code;
    throw error;
  }
  if (!binaryPath) throw new Error(`Cargo did not report an executable for ${binary}`);
  return resolve(directory, binaryPath);
}

await main(import.meta.url, async () => output("binary-path", await cargoBuild({
  binary: input("binary"), package: input("package", ""), target: input("target", ""), directory: input("working-directory", "."),
})));
