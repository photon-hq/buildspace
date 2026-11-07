import childProcess from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const fixture = JSON.parse(readFileSync(process.env.RELEASE_CLI_FIXTURE, "utf8"));
const execute = childProcess.execFileSync;

childProcess.execFileSync = (command, args, options) => {
  if (command === "tar") return execute(command, args, options);
  if (command === "git") {
    const operation = args[2];
    if (operation === "tag") return "v0.1.0\n";
    if (operation === "log") {
      const paths = args.slice(args.indexOf("--") + 1);
      return fixture.commits
        .filter((commit) => !paths.length || commit.paths.some((file) => paths.some((path) => file === path || file.startsWith(`${path}/`))))
        .map(({ sha, subject, body = "" }) => `${sha}\0${subject}\0${body}\x1e\n`)
        .join("");
    }
  }
  if (command === "gh" && args[0] === "api" && args[1] === "graphql")
    return JSON.stringify({ data: { repository: {} } });
  if (command === "gh" && args[0] === "release" && args[1] === "download" && args[2] === "v0.1.0") {
    const file = args[args.indexOf("--pattern") + 1];
    const directory = args[args.indexOf("--dir") + 1];
    copyFileSync(join(fixture.released, file), join(directory, file));
    return "";
  }
  throw new Error(`Unexpected external command: ${command} ${args.join(" ")}`);
};
syncBuiltinESMExports();

globalThis.fetch = async (url) => {
  if (url !== "https://registry.npmjs.org/adapter?write=true")
    throw new Error(`Unexpected registry request: ${url}`);
  return new Response(JSON.stringify(fixture.registry));
};
