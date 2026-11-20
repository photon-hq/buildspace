import { appendFile, writeFile } from "node:fs/promises";
import nodePath from "node:path";
import { parseArgs } from "node:util";
import {
  auditProductionDependencies,
  checkProductionDependencies,
  inspectProductionDependencies,
} from "./dependency-audit.mjs";
import { readProductionInputs } from "./production-inputs.mjs";
import { renderProductionReport } from "./production-report.mjs";

export {
  auditProductionDependencies,
  checkProductionDependencies,
  inspectProductionDependencies,
  readProductionInputs,
  renderProductionReport,
};

if (
  process.argv[1] &&
  nodePath.resolve(process.argv[1]) === import.meta.filename
) {
  try {
    const { values } = parseArgs({
      options: { ref: { type: "string" }, "report-file": { type: "string" } },
    });

    let report;

    try {
      const inputs = await readProductionInputs(process.cwd(), values.ref);
      report = await auditProductionDependencies(inputs);
    } catch (error) {
      report = {
        source: values.ref || "working tree",
        packages: [],
        errors: [error.message],
      };
    }

    const body = renderProductionReport(report);
    console.info(body);

    if (values["report-file"]) {
      await writeFile(values["report-file"], body);
    }

    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, body);
    }

    if (report.errors.length) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
