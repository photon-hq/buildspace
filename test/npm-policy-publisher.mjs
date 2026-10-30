import { appendFileSync } from "node:fs";

const mode = process.env.POLICY_MODE;
const hasToken = Boolean(process.env.NODE_AUTH_TOKEN);
appendFileSync(process.env.POLICY_LOG, `${JSON.stringify({ mode, hasToken, args: process.argv.slice(2) })}\n`);
if (mode === "failure" && !hasToken) process.exit(23);
if (mode === "swallowed") console.error("npm error fixture: publisher swallowed a failure");
