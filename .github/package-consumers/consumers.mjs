// Comment on a PR that changes a published package: which deployed services
// use it, and at which version in production, in staging and on main (ENG-5843).
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseToml, parseYaml } from "../blocks/check-production-dependencies/lockfiles.mjs";
import { cargoUses, mergeUses, pnpmUses } from "./graph.mjs";

const exec = promisify(execFile);
const MANIFEST = "photon-hq/application-manifest";
export const ENVIRONMENTS = [
  ["production", "clusters/photon-production"],
  ["staging", "clusters/photon-staging-usw2"],
];
const COLUMNS = ["production", "staging", "main"];
// Deployed by workflow_dispatch, not from application-manifest: their running
// commits are not recorded yet (M1), so only main is read.
export const MAIN_ONLY = ["dashboard-v2", "landing-v1", "mcp-internal"];
const LIMIT = 60_000;

const within = (path, dir) => dir === "." || path === dir || path.startsWith(`${dir}/`);

/**
 * The packages a change touches: npm packages under @photon-hq/ that are not
 * private, library crates, and buf modules, whose SDKs are `@buf/photon-hq_<module>.*`.
 * `files` maps a manifest path to a reader of its content; `paths` holds every file path.
 */
export async function changedPackages(changed, files, paths = new Set()) {
  const packages = [];
  for (const [path, read] of files) {
    const dir = dirname(path);
    try {
      if (path.endsWith("package.json")) {
        const manifest = JSON.parse(await read());
        if (manifest.name?.startsWith("@photon-hq/") && !manifest.private)
          packages.push({ kind: "npm", name: manifest.name, dir, manifest: path });
      } else if (path.endsWith("Cargo.toml")) {
        // Internal crates are `publish = false` too; only a library can be a dependency.
        const manifest = parseToml(await read());
        const name = manifest.package?.name;
        if (typeof name === "string" && (manifest.lib || paths.has(join(dir, "src/lib.rs"))))
          packages.push({ kind: "crate", name, dir, manifest: path });
      } else if (path.endsWith("buf.yaml")) {
        const config = parseYaml(await read());
        const modules = config.version === "v2" ? config.modules ?? [] : [{ path: ".", name: config.name }];
        for (const module of modules) {
          const name = /^buf\.build\/photon-hq\/([a-z0-9-]+)$/.exec(module.name ?? "")?.[1];
          if (name) packages.push({ kind: "buf", name: `buf.build/photon-hq/${name}`, prefix: `@buf/photon-hq_${name}.`, dir: normalize(join(dir, module.path ?? ".")), manifest: path });
        }
      }
    } catch {
      // Not a manifest the ecosystem could have published.
    }
  }
  // A manifest belongs to the packages it declares (a buf.yaml sits outside its
  // modules); any other file to every package of the innermost directory holding it.
  const touched = new Map();
  for (const path of changed) {
    let owners = packages.filter((entry) => entry.manifest === path);
    if (!owners.length) {
      const holding = packages.filter((entry) => within(path, entry.dir));
      const innermost = Math.max(...holding.map((entry) => entry.dir.length));
      owners = holding.filter((entry) => entry.dir.length === innermost);
    }
    for (const owner of owners) touched.set(`${owner.kind}:${owner.name}`, owner);
  }
  return [...touched.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function watcher(packages) {
  const names = new Set(packages.filter((entry) => entry.kind !== "buf").map((entry) => entry.name));
  const prefixes = packages.filter((entry) => entry.kind === "buf").map((entry) => entry.prefix);
  return (name) => names.has(name) || prefixes.some((prefix) => name.startsWith(prefix));
}

/**
 * The uses in every pnpm-lock.yaml and Cargo.lock of a commit, given its file
 * paths. A commit with an npm or Cargo project but neither lockfile is
 * { missing: true }, so it is not read as using nothing; one with no such
 * project (lago is Ruby) cannot use the packages.
 */
export async function commitUses(paths, read, watched) {
  const found = (pattern) => paths.filter((path) => pattern.test(path) && !path.split("/").includes("node_modules"));
  const lockfiles = found(/(^|\/)(pnpm-lock\.yaml|Cargo\.lock)$/);
  if (!lockfiles.length) return found(/(^|\/)(package\.json|Cargo\.toml)$/).length ? { missing: true } : { uses: new Map() };
  const uses = await Promise.all(lockfiles.map(async (path) => {
    const text = await read(path);
    try {
      return !text ? new Map() : path.endsWith("Cargo.lock") ? cargoUses(text, watched) : pnpmUses(text, watched);
    } catch (error) {
      throw new Error(`${path}: ${error.message}`);
    }
  }));
  return { uses: mergeUses(...uses) };
}

// A buf SDK version is <plugin>-<timestamp>-<module commit>.<n>: show the
// module commit and its date, which orders the commits.
const display = (version) => {
  const sdk = /^\d+\.\d+\.\d+-(\d{4})(\d{2})(\d{2})\d{6}-([0-9a-f]{12})\.\d+$/.exec(version);
  return sdk ? `${sdk[1]}-${sdk[2]}-${sdk[3]} · ${sdk[4]}` : version;
};
const code = (value) => `\`${String(value).replace(/[`|\r\n]/g, "")}\``;

/**
 * `services` is [{ service, repository, production?, staging?, main? }], where
 * each environment holds that commit's { uses }, { missing }, { untracked } or
 * { error }. A cell is `—` when not deployed, `none` when the package is not
 * used and `?` when the commit could not be checked. `head` is the commit the
 * comment describes. Empty when there is nothing to say.
 */
export function renderComment(packages, services, head) {
  const sections = [];
  const unused = [];
  const failures = [];
  const unchecked = [];
  for (const service of services) {
    const failed = COLUMNS.filter((column) => service[column]?.error);
    const reasons = [...new Set(failed.map((column) => service[column].error))];
    if (failed.length) failures.push(`${service.service} ${failed.join("/")} (${reasons.join("; ")})`);
    const missing = COLUMNS.filter((column) => service[column]?.missing);
    if (missing.length) unchecked.push(`${service.service} ${missing.join("/")}`);
  }
  for (const entry of packages) {
    const matches = entry.kind === "buf" ? (name) => name.startsWith(entry.prefix) : (name) => name === entry.name;
    const rows = [];
    for (const service of services) {
      const cells = [];
      // A column that uses the package directly needs no path; a column that
      // only reaches it indirectly keeps its paths, whatever the others do.
      const vias = new Set();
      let used = false;
      let direct = false;
      for (const column of COLUMNS) {
        if (!service[column]?.uses) {
          cells.push(service[column] ? "?" : "—");
          continue;
        }
        const versions = new Set();
        const through = new Set();
        for (const [name, found] of service[column].uses) {
          if (!matches(name)) continue;
          for (const [version, paths] of found) {
            versions.add(display(version));
            for (const via of paths) through.add(via);
          }
        }
        used ||= versions.size > 0;
        if (through.has("")) direct = true;
        else for (const via of through) vias.add(via);
        cells.push(versions.size ? [...versions].sort().join(", ").replace(/[|\r\n]/g, "") : "none");
      }
      if (!used) continue;
      const indirect = [...vias].sort();
      const label = !indirect.length ? service.service
        : `${service.service} (${direct ? "direct and " : ""}via ${indirect.map(code).join(", ")})`;
      rows.push(`| ${label} | ${cells.join(" | ")} |`);
    }
    const title = entry.kind === "buf" ? `${code(entry.name)} SDKs` : code(entry.name);
    if (rows.length) sections.push(`#### ${title}`, "", "| Service | Production | Staging | main |", "| --- | --- | --- | --- |", ...rows, "");
    else if (entry.kind !== "crate") unused.push(title);
  }
  // A service's own crates are packages too; with no use to show, say nothing.
  if (!sections.length && !unused.length) return "";
  const lines = ["### Services using the packages this PR changes", "", ...sections];
  if (unused.length && (failures.length || unchecked.length)) lines.push(`No use of ${unused.join(", ")} found in the services that could be checked.`, "");
  else if (unused.length) lines.push(`No deployed service uses ${unused.join(", ")}.`, "");
  if (unchecked.length) lines.push(`Not checked (no pnpm-lock.yaml or Cargo.lock): ${unchecked.join("; ")}.`, "");
  if (failures.length) lines.push(`Could not read: ${failures.join("; ")}.`, "");
  const mainOnly = services.filter((service) => service.production?.untracked).map((service) => service.service);
  if (mainOnly.length) lines.push(`Only main is checked for ${mainOnly.join(", ")}: they are not deployed from application-manifest.`, "");
  let body = lines.join("\n").trimEnd();
  if (body.length > LIMIT) body = `${body.slice(0, body.lastIndexOf("\n", LIMIT))}\n\nThe list is cut off at GitHub's comment size limit.`;
  // A failed run keeps the previous comment; this says which push it describes.
  if (head) body += `\n\nChecked for ${head.slice(0, 7)}.`;
  return body;
}

export function github(token, fetchImpl = fetch) {
  return async (path, accept = "application/vnd.github+json") => {
    for (let attempt = 1; ; attempt++) {
      const response = await fetchImpl(`https://api.github.com/${path}`, {
        headers: { authorization: `Bearer ${token}`, accept, "x-github-api-version": "2022-11-28" },
        redirect: "follow",
        signal: AbortSignal.timeout(60_000),
      });
      if (response.status === 404) return undefined;
      if (response.ok) return accept.endsWith("+json") && !accept.includes("raw") ? response.json() : response.text();
      if (attempt === 3 || ![429, 500, 502, 503, 504].includes(response.status))
        throw new Error(`HTTP ${response.status}`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  };
}

async function pool(items, size, task) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  }));
  return results;
}

/** Deployed services with their repository and the commits running in each environment. */
export async function deployedServices(api) {
  const services = new Map();
  for (const [environment, root] of ENVIRONMENTS) {
    const listing = await api(`repos/${MANIFEST}/contents/${root}?ref=main`);
    // Not "no services": the previous comment must stay as it was.
    if (!listing) throw new Error(`Cannot read ${MANIFEST}/${root}`);
    const names = listing.filter((entry) => entry.type === "dir").map((entry) => entry.name);
    await pool(names, 8, async (name) => {
      const text = await api(`repos/${MANIFEST}/contents/${root}/${name}/deployment-ref.yaml?ref=main`, "application/vnd.github.raw+json");
      const deployment = text && parseYaml(text)?.deployment;
      const repository = /^https:\/\/github\.com\/(photon-hq\/[A-Za-z0-9._-]+)$/.exec(deployment?.repoURL ?? "")?.[1];
      if (!repository || !/^[0-9a-f]{40}$/.test(deployment.ref ?? "")) return;
      const service = services.get(name) ?? { service: name, repository };
      service[environment] = deployment.ref;
      services.set(name, service);
    });
  }
  for (const name of MAIN_ONLY)
    if (!services.has(name)) services.set(name, { service: name, repository: `photon-hq/${name}`, mainOnly: true });
  return [...services.values()].sort((a, b) => a.service.localeCompare(b.service));
}

/** Fill each service's production, staging and main columns with that commit's uses. */
export async function readConsumers(api, services, watched) {
  const heads = new Map();
  const commits = new Map();
  const usesOf = (repository, sha) => {
    const key = `${repository}@${sha}`;
    // ponytail: reads every lockfile on every push; cache per commit (actions/cache) if runs get slow.
    if (!commits.has(key))
      commits.set(key, (async () => {
        const tree = await api(`repos/${repository}/git/trees/${sha}?recursive=1`);
        if (!tree) throw new Error("commit not found");
        if (tree.truncated) throw new Error("file tree too large to list");
        const paths = tree.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path);
        const read = (path) => api(`repos/${repository}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`, "application/vnd.github.raw+json");
        return commitUses(paths, read, watched);
      })().catch((error) => ({ error: error.message.split("\n")[0].slice(0, 120) })));
    return commits.get(key);
  };
  await pool(services, 8, async (service) => {
    // A repository the token cannot see answers 404 to every lockfile read, which
    // would read as "no use"; check it first.
    if (!heads.has(service.repository))
      heads.set(service.repository, api(`repos/${service.repository}/commits/HEAD`, "application/vnd.github.sha")
        .then((sha) => sha ? { sha } : { error: "repository not readable" }, (error) => ({ error: error.message })));
    const main = await heads.get(service.repository);
    for (const [column, sha] of [["production", service.production], ["staging", service.staging], ["main", main.sha]]) {
      if (service.mainOnly && column !== "main") service[column] = { untracked: true };
      else if (main.error) service[column] = column === "main" || sha ? { error: main.error } : undefined;
      else service[column] = sha ? await usesOf(service.repository, sha) : undefined;
    }
  });
  return services;
}

/**
 * The packages changed between the PR's merge base and head, found in both
 * trees: a deleted, moved or renamed package is still known at the merge base.
 */
export async function packagesBetween(git, base, head) {
  const fork = (await git("merge-base", base, head)).trim();
  const changed = (await git("diff", "--no-renames", "--name-only", "-z", `${fork}..${head}`)).split("\0").filter(Boolean);
  const touched = new Map();
  for (const commit of [fork, head]) {
    const paths = new Set((await git("ls-tree", "-rz", "--name-only", commit)).split("\0").filter(Boolean));
    const manifests = [...paths]
      .filter((path) => /(^|\/)(package\.json|Cargo\.toml|buf\.yaml)$/.test(path) && !path.split("/").includes("node_modules"));
    for (const entry of await changedPackages(changed, manifests.map((path) => [path, () => git("show", `${commit}:${path}`)]), paths))
      touched.set(`${entry.kind}:${entry.name}`, entry);
  }
  return [...touched.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function main() {
  const { GITHUB_REPOSITORY: repository, BASE_SHA: base, HEAD_SHA: head, GH_TOKEN: token, OUTPUT: output } = process.env;
  const git = async (...args) => (await exec("git", args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
  const packages = await packagesBetween(git, base, head);
  let body = "";
  if (packages.length) {
    console.log(`Changed packages: ${packages.map((entry) => entry.name).join(", ")}`);
    const api = github(token);
    const services = (await deployedServices(api)).filter((service) => service.repository !== repository);
    body = renderComment(packages, await readConsumers(api, services, watcher(packages)), head);
  }
  await writeFile(output, body);
  console.log(body || "Nothing to comment: no published package changes, or no deployed service uses them");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
