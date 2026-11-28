// Which versions of the watched packages a commit's lockfiles resolve, and
// through which direct dependency each one arrives.
import { parsePnpmLockfile, parseToml } from "../blocks/check-production-dependencies/lockfiles.mjs";

const FIELDS = ["dependencies", "devDependencies", "optionalDependencies"];
const baseVersion = (version) => String(version).split("(")[0];
// An npm alias resolves to "<real name>@<version>" instead of a version.
const ALIAS = /^(@[^/@]+\/[^@]+|[^@(:/][^@(:]*)@(\d.*)$/;

/**
 * Walk from every direct dependency and record each watched package reached:
 * `uses` maps name -> version -> set of the direct dependencies it came
 * through, where "" means the package is itself a direct dependency.
 */
function walk(starts, children, watched) {
  const uses = new Map();
  const record = (node, via) => {
    if (!watched(node.name)) return;
    if (!uses.has(node.name)) uses.set(node.name, new Map());
    const versions = uses.get(node.name);
    if (!versions.has(node.version)) versions.set(node.version, new Set());
    versions.get(node.version).add(via);
  };
  for (const start of starts) {
    record(start, "");
    const seen = new Set([start.key]);
    const queue = [start];
    while (queue.length) {
      for (const child of children(queue.shift())) {
        if (seen.has(child.key)) continue;
        seen.add(child.key);
        record(child, start.name);
        queue.push(child);
      }
    }
  }
  return uses;
}

export function pnpmUses(text, watched) {
  const { lockfile } = parsePnpmLockfile(text);
  const node = (name, version) => {
    const alias = ALIAS.exec(String(version));
    if (alias) [, name, version] = alias;
    return { key: `${name}@${version}`, name, version: baseVersion(version) };
  };
  const starts = new Map();
  for (const importer of Object.values(lockfile.importers ?? {})) {
    for (const field of FIELDS) {
      for (const [name, entry] of Object.entries(importer[field] ?? {})) {
        // A workspace package is an importer of its own, walked from there.
        if (String(entry.version).startsWith("link:")) continue;
        const start = node(name, entry.version);
        starts.set(start.key, start);
      }
    }
  }
  const children = ({ key }) => {
    const snapshot = lockfile.snapshots?.[key] ?? {};
    return ["dependencies", "optionalDependencies"].flatMap((field) =>
      Object.entries(snapshot[field] ?? {})
        .filter(([, version]) => !String(version).startsWith("link:"))
        .map(([name, version]) => node(name, version)));
  };
  return walk(starts.values(), children, watched);
}

export function cargoUses(text, watched) {
  const packages = parseToml(text).package ?? [];
  // Internal crates come from git, where the Cargo version is not bumped: show
  // the release tag, or the short commit of a rev or branch.
  const gitVersion = (source = "") => source.startsWith("git+")
    ? /[?&]tag=([^#&]+)/.exec(source)?.[1] ?? /#([0-9a-f]{7})/.exec(source)?.[1]
    : undefined;
  const node = (entry) => ({
    key: `${entry.name} ${entry.version} ${entry.source ?? ""}`,
    name: entry.name,
    version: gitVersion(entry.source) ?? entry.version,
    entry,
  });
  const byName = Map.groupBy(packages, (entry) => entry.name);
  // A dependency is "name", "name version" or "name version (source)".
  const resolve = (reference) => {
    const [name, version] = reference.split(" ");
    return byName.get(name)?.find((entry) => !version || entry.version === version);
  };
  const members = packages.filter((entry) => !entry.source);
  const starts = new Map();
  for (const member of members) {
    for (const reference of member.dependencies ?? []) {
      const entry = resolve(reference);
      // Another workspace member is walked as a member.
      if (!entry || !entry.source) continue;
      const start = node(entry);
      starts.set(start.key, start);
    }
  }
  const children = ({ entry }) =>
    (entry.dependencies ?? []).map(resolve).filter(Boolean).map(node);
  return walk(starts.values(), children, watched);
}

/** Merge per-ecosystem results into one map of the same shape. */
export function mergeUses(...results) {
  const merged = new Map();
  for (const uses of results) {
    for (const [name, versions] of uses) {
      if (!merged.has(name)) merged.set(name, new Map());
      for (const [version, vias] of versions) {
        const target = merged.get(name);
        if (!target.has(version)) target.set(version, new Set());
        for (const via of vias) target.get(version).add(via);
      }
    }
  }
  return merged;
}
