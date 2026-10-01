import { execFile } from "node:child_process";
import { appendFile, glob, readFile, writeFile } from "node:fs/promises";
import { dirname, join, matchesGlob, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import semver from "semver";
import { parse } from "yaml";
import { fetchPackageMetadata, INTERNAL_PREFIX } from "./internal-packages.mjs";

const exec = promisify(execFile);
const FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const internal = (name) => name.startsWith(INTERNAL_PREFIX);
const baseVersion = (version) => String(version ?? "").split("(")[0];
const exactStable = (version) => {
  const parsed = typeof version === "string" ? semver.parse(version) : null;
  return (
    parsed !== null &&
    parsed.prerelease.length === 0 &&
    `${parsed.version}${parsed.build.length ? `+${parsed.build.join(".")}` : ""}` ===
      version
  );
};

// Read a ref directly from Git: never check out or rewrite the caller's files.
export async function readProductionInputs(root, ref) {
  const git = async (...args) =>
    (await exec("git", args, { cwd: root, maxBuffer: 16 * 1024 * 1024 }))
      .stdout;
  const source = ref
    ? (
        await git(
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${ref}^{commit}`
        )
      ).trim()
    : "working tree";
  const read = ref
    ? (path) => git("show", `${source}:${path}`)
    : (path) => readFile(join(root, path), "utf8");
  const workspace = parse(await read("pnpm-workspace.yaml"));
  const patterns = workspace.packages ?? [];
  const included = (path) =>
    patterns.some(
      (pattern) => !pattern.startsWith("!") && matchesGlob(path, pattern)
    ) &&
    !patterns.some(
      (pattern) =>
        pattern.startsWith("!") && matchesGlob(path, pattern.slice(1))
    );
  let paths;
  if (ref) {
    paths = (await git("ls-tree", "-rz", "--name-only", source))
      .split("\0")
      .filter(
        (path) => path.endsWith("/package.json") && included(dirname(path))
      );
  } else {
    paths = [];
    for (const pattern of patterns.filter((entry) => !entry.startsWith("!"))) {
      for await (const path of glob(`${pattern}/package.json`, {
        cwd: root,
        exclude: ["**/node_modules/**", "**/.git/**"],
      })) {
        if (included(dirname(path))) paths.push(path);
      }
    }
  }
  const manifests = Object.fromEntries(
    await Promise.all(
      [...new Set(["package.json", ...paths])].map(async (path) => [
        dirname(path),
        JSON.parse(await read(path)),
      ])
    )
  );
  return {
    source,
    workspace,
    manifests,
    lockfile: parse(await read("pnpm-lock.yaml")),
  };
}

/** Audit the declared pins and the entire resolved internal dependency graph. */
export function inspectProductionDependencies({
  workspace,
  manifests,
  lockfile,
}) {
  const errors = new Set();
  const versions = new Map();
  const localPackages = new Map();
  for (const [path, manifest] of Object.entries(manifests)) {
    if (localPackages.has(manifest.name))
      errors.add(`Duplicate workspace package: ${manifest.name}`);
    localPackages.set(manifest.name, path);
  }
  const localLink = (name, version, from) =>
    typeof version === "string" &&
    version.startsWith("link:") &&
    localPackages.get(name) === normalize(join(from, version.slice(5)));

  const add = (name, version) => {
    if (!versions.has(name)) versions.set(name, new Set());
    versions.get(name).add(String(version ?? "missing"));
    if (!exactStable(version)) {
      errors.add(
        `${name}@${version}: must be pinned to an exact stable production version`
      );
    }
  };
  const catalogs = { default: workspace.catalog ?? {}, ...workspace.catalogs };
  const pin = (name, value) => {
    const version =
      typeof value === "string" && value.startsWith("catalog:")
        ? catalogs[value.slice(8) || "default"]?.[name]
        : value;
    add(name, version);
    return version;
  };
  const rejectAlias = (name, value) => {
    if (!internal(name) && /^(?:npm:)?@photon-hq\//.test(String(value))) {
      const target = /^(?:npm:)?(@photon-hq\/[^@()/\s]+)(?:@(.+))?$/.exec(
        String(value)
      );
      if (target) add(target[1], baseVersion(target[2] || "latest"));
      errors.add(
        `${name}: internal package aliases are not supported; use the @photon-hq package name`
      );
    }
  };
  const resolved = (name, value) => {
    rejectAlias(name, value);
    if (!internal(name)) return;
    const version = baseVersion(value);
    add(name, version);
    if (
      !lockfile.packages?.[`${name}@${version}`] ||
      !lockfile.snapshots?.[`${name}@${value}`]
    ) {
      errors.add(
        `${name}@${value}: missing lockfile package or snapshot record`
      );
    }
  };
  if (
    String(lockfile.lockfileVersion) !== "9.0" ||
    !lockfile.importers ||
    !lockfile.packages ||
    !lockfile.snapshots
  ) {
    errors.add(
      "Expected a complete pnpm v9 lockfile (importers, packages, and snapshots)"
    );
  }
  for (const catalog of Object.values(catalogs)) {
    for (const [name, version] of Object.entries(catalog)) {
      rejectAlias(name, version);
      if (internal(name)) add(name, version);
    }
  }
  for (const [catalogName, catalog] of Object.entries(
    lockfile.catalogs ?? {}
  )) {
    for (const [name, entry] of Object.entries(catalog)) {
      rejectAlias(name, entry.version);
      if (!internal(name)) continue;
      add(name, baseVersion(entry.version));
      if (
        entry.specifier !== catalogs[catalogName]?.[name] ||
        baseVersion(entry.version) !== catalogs[catalogName]?.[name]
      ) {
        errors.add(
          `${name}: lockfile catalog ${catalogName} does not match the declared pin`
        );
      }
    }
  }
  for (const [path, manifest] of Object.entries(manifests)) {
    for (const field of FIELDS) {
      for (const [name, value] of Object.entries(manifest[field] ?? {})) {
        rejectAlias(name, value);
        if (!internal(name)) continue;
        const importer = lockfile.importers?.[path];
        // pnpm installs workspace peer dependencies as dependencies/devDependencies.
        const entry =
          field === "peerDependencies"
            ? (importer?.dependencies?.[name] ??
              importer?.devDependencies?.[name] ??
              importer?.optionalDependencies?.[name])
            : importer?.[field]?.[name];
        if (
          String(value).startsWith("workspace:") &&
          entry?.specifier === value &&
          localLink(name, entry.version, path)
        ) continue;
        const version = pin(name, value);
        if (
          !entry ||
          baseVersion(entry.version) !== version ||
          entry.specifier !== value
        ) {
          errors.add(
            `${path}: ${name} lockfile importer does not match ${value} (${version})`
          );
        }
        if (String(value).startsWith("catalog:")) {
          const catalogName = value.slice(8) || "default";
          if (!lockfile.catalogs?.[catalogName]?.[name])
            errors.add(`${name}: missing lockfile catalog ${catalogName}`);
        }
      }
    }
  }
  for (const [path, importer] of Object.entries(lockfile.importers ?? {})) {
    for (const field of FIELDS) {
      for (const [name, entry] of Object.entries(importer[field] ?? {})) {
        if (!localLink(name, entry.version, path)) resolved(name, entry.version);
        if (
          internal(name) &&
          !FIELDS.some((key) => manifests[path]?.[key]?.[name])
        ) {
          errors.add(
            `${path}: ${name} lockfile importer has no manifest declaration`
          );
        }
      }
    }
  }
  for (const section of ["packages", "snapshots"]) {
    for (const [key, entry] of Object.entries(lockfile[section] ?? {})) {
      // Include peer contexts, including internal peers of third-party packages.
      for (const match of key.matchAll(/(@photon-hq\/[^@()/\s]+)@([^()]+)/g)) {
        add(match[1], match[2]);
        if (!lockfile.packages?.[`${match[1]}@${match[2]}`])
          errors.add(
            `${match[1]}@${match[2]}: missing lockfile package record`
          );
      }
      if (section === "snapshots") {
        for (const field of ["dependencies", "optionalDependencies"]) {
          for (const [name, value] of Object.entries(entry[field] ?? {}))
            resolved(name, value);
        }
      }
    }
  }
  return { errors: [...errors].sort(), versions };
}

/** Return a full report even when some pins or registry lookups fail. */
export async function auditProductionDependencies(
  inputs,
  loadMetadata = fetchPackageMetadata
) {
  const { errors, versions } = inspectProductionDependencies(inputs);
  const packages = [...versions]
    .flatMap(([name, pins]) =>
      [...pins].map((version) => ({
        name,
        version,
        production: exactStable(version) ? null : false,
        reason: exactStable(version)
          ? "Publication not verified"
          : "Not an exact stable version",
      }))
    )
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
    );
  // Verify stable rows even when other packages are on staging, so the PR
  // table reports each package independently without ever selecting new pins.
  await Promise.all(
    [...versions.keys()].map(async (name) => {
      const rows = packages.filter(
        (entry) => entry.name === name && entry.production === null
      );
      if (!rows.length) return;
      try {
        const metadata = await loadMetadata(name);
        for (const row of rows) {
          const release = metadata.versions?.[row.version];
          row.production = Boolean(release && !release.deprecated);
          row.reason = !release
            ? "Not published"
            : release.deprecated
              ? "Deprecated"
              : "Published stable version";
          if (!row.production)
            errors.push(
              `${name}@${row.version}: exact version is ${release ? "deprecated" : "not published"}`
            );
        }
      } catch (error) {
        for (const row of rows) row.reason = "Registry lookup failed";
        errors.push(`${name}: ${error.message}`);
      }
    })
  );
  return { source: inputs.source, packages, errors: errors.sort() };
}

export async function checkProductionDependencies(
  inputs,
  loadMetadata = fetchPackageMetadata
) {
  const report = await auditProductionDependencies(inputs, loadMetadata);
  if (report.errors.length)
    throw new Error(
      `Production dependency check failed:\n${report.errors.map((error) => `- ${error}`).join("\n")}\nPublish and review compatible stable pins and their lockfile before releasing.`
    );
  return report.packages
    .map(({ name, version }) => `${name}@${version}`)
    .sort();
}

// Escape data before putting it in a Markdown table or comment. Package metadata
// must not inject rows, HTML, or user mentions into the bot's report.
const markdown = (value) =>
  String(value).replace(
    /[&<>|`*_[\]@\r\n\\]/g,
    (character) => `&#${character.charCodeAt(0)};`
  );

export function renderProductionReport({ source, packages, errors }) {
  const rows = packages.map(
    ({ name, version, production, reason }) =>
      `| ${markdown(name)} | ${markdown(version)} | ${production === true ? "✅ Yes" : production === false ? "❌ No" : "❓ Unknown"} | ${markdown(reason)} |`
  );
  return [
    "## Production dependencies",
    "",
    `Source: ${markdown(source)}`,
    "",
    errors.length
      ? "**Production dependency check failed.**"
      : "**Production dependency check passed.**",
    "",
    "| Internal package | Version | Prod? | Reason |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    ...(packages.length ? [] : ["No package inventory is available.", ""]),
    "Prod means the exact version is stable, published, and not deprecated. Includes direct and transitive `@photon-hq/*` dependencies. Unknown means registry status could not be verified.",
    "",
    ...(errors.length
      ? [
          "### Findings",
          "",
          ...errors.map((error) => `- ${markdown(error)}`),
          "",
          "Review these findings against the current dependency policy.",
          "",
        ]
      : []),
  ].join("\n");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
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
    if (values["report-file"]) await writeFile(values["report-file"], body);
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(process.env.GITHUB_STEP_SUMMARY, body);
    if (report.errors.length) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
