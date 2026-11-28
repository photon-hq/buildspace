// Comment on a PR that changes a published package: which deployed services
// use it, and at which version in production, in staging and on main (ENG-5843).
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
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
const LIMIT = 60_000;

const within = (path, dir) => dir === "." || path === dir || path.startsWith(`${dir}/`);

/**
 * The packages a change touches: npm packages under @photon-hq/ that are not
 * private, Cargo crates, and buf modules, whose SDKs are `@buf/photon-hq_<module>.*`.
 * `files` maps a path at the head commit to a reader of its content.
 */
export async function changedPackages(changed, files) {
  const packages = [];
  for (const [path, read] of files) {
    const dir = dirname(path);
    try {
      if (path.endsWith("package.json")) {
        const manifest = JSON.parse(await read());
        if (manifest.name?.startsWith("@photon-hq/") && !manifest.private)
          packages.push({ kind: "npm", name: manifest.name, dir });
      } else if (path.endsWith("Cargo.toml")) {
        const name = parseToml(await read()).package?.name;
        if (typeof name === "string") packages.push({ kind: "crate", name, dir });
      } else if (path.endsWith("buf.yaml")) {
        const config = parseYaml(await read());
        const modules = config.version === "v2" ? config.modules ?? [] : [{ path: ".", name: config.name }];
        for (const module of modules) {
          const name = /^buf\.build\/photon-hq\/([a-z0-9-]+)$/.exec(module.name ?? "")?.[1];
          if (name) packages.push({ kind: "buf", name: `buf.build/photon-hq/${name}`, prefix: `@buf/photon-hq_${name}.`, dir: normalize(join(dir, module.path ?? ".")) });
        }
      }
    } catch {
      // Not a manifest the ecosystem could have published.
    }
  }
  // A file belongs to the innermost package that contains it.
  const touched = new Map();
  for (const path of changed) {
    const owner = packages
      .filter((entry) => within(path, entry.dir))
      .sort((a, b) => b.dir.length - a.dir.length)[0];
    if (owner) touched.set(`${owner.kind}:${owner.name}`, owner);
  }
  return [...touched.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function watcher(packages) {
  const names = new Set(packages.filter((entry) => entry.kind !== "buf").map((entry) => entry.name));
  const prefixes = packages.filter((entry) => entry.kind === "buf").map((entry) => entry.prefix);
  return (name) => names.has(name) || prefixes.some((prefix) => name.startsWith(prefix));
}

/** The lockfile uses of one commit. A missing lockfile is no use. */
export async function commitUses(read, watched) {
  const [pnpm, cargo] = await Promise.all([read("pnpm-lock.yaml"), read("Cargo.lock")]);
  return mergeUses(
    pnpm ? pnpmUses(pnpm, watched) : new Map(),
    cargo ? cargoUses(cargo, watched) : new Map(),
  );
}

// A buf SDK version is <plugin>-<timestamp>-<module commit>.<n>; the module commit is what differs.
const display = (version) => /^\d+\.\d+\.\d+-\d{14}-([0-9a-f]{12})\.\d+$/.exec(version)?.[1] ?? version;
const code = (value) => `\`${String(value).replace(/[`|\r\n]/g, "")}\``;

/**
 * `services` is [{ service, repository, production?, staging?, main? }], where
 * each environment holds that commit's uses or { error }.
 */
export function renderComment(packages, services) {
  const sections = [];
  const unused = [];
  const failures = [];
  for (const service of services) {
    const failed = COLUMNS.filter((column) => service[column]?.error);
    const reasons = [...new Set(failed.map((column) => service[column].error))];
    if (failed.length) failures.push(`${service.service} ${failed.join("/")} (${reasons.join("; ")})`);
  }
  for (const entry of packages) {
    const matches = entry.kind === "buf" ? (name) => name.startsWith(entry.prefix) : (name) => name === entry.name;
    const rows = [];
    for (const service of services) {
      const cells = [];
      const vias = new Set();
      for (const column of COLUMNS) {
        const versions = new Set();
        for (const [name, found] of service[column]?.uses ?? []) {
          if (!matches(name)) continue;
          for (const [version, through] of found) {
            versions.add(display(version));
            for (const via of through) vias.add(via);
          }
        }
        cells.push(versions.size ? [...versions].sort().join(", ").replace(/[|\r\n]/g, "") : "—");
      }
      if (!vias.size) continue;
      const indirect = vias.has("") ? [] : [...vias].sort();
      const label = indirect.length ? `${service.service} (via ${indirect.map(code).join(", ")})` : service.service;
      rows.push(`| ${label} | ${cells.join(" | ")} |`);
    }
    const title = entry.kind === "buf" ? `${code(entry.name)} SDKs` : code(entry.name);
    if (rows.length) sections.push(`#### ${title}`, "", "| Service | Production | Staging | main |", "| --- | --- | --- | --- |", ...rows, "");
    else if (entry.kind !== "crate") unused.push(title);
  }
  const lines = ["### Services using the packages this PR changes", "", ...sections];
  if (unused.length) lines.push(`No deployed service uses ${unused.join(", ")}.`, "");
  if (failures.length) lines.push(`Could not read: ${failures.join("; ")}.`, "");
  let body = lines.join("\n").trimEnd();
  if (body.length > LIMIT) body = `${body.slice(0, body.lastIndexOf("\n", LIMIT))}\n\nThe list is cut off at GitHub's comment size limit.`;
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
    const names = (listing ?? []).filter((entry) => entry.type === "dir").map((entry) => entry.name);
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
      commits.set(key, commitUses((path) => api(`repos/${repository}/contents/${path}?ref=${sha}`, "application/vnd.github.raw+json"), watched)
        .then((uses) => ({ uses }), (error) => ({ error: error.message.split("\n")[0].slice(0, 120) })));
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
      if (main.error) service[column] = column === "main" || sha ? { error: main.error } : undefined;
      else service[column] = sha ? await usesOf(service.repository, sha) : undefined;
    }
  });
  return services;
}

async function main() {
  const { GITHUB_REPOSITORY: repository, BASE_SHA: base, HEAD_SHA: head, GH_TOKEN: token, OUTPUT: output } = process.env;
  const git = async (...args) => (await exec("git", args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
  const changed = (await git("diff", "--name-only", "-z", `${base}...${head}`)).split("\0").filter(Boolean);
  const manifests = (await git("ls-tree", "-rz", "--name-only", head)).split("\0")
    .filter((path) => /(^|\/)(package\.json|Cargo\.toml|buf\.yaml)$/.test(path) && !path.split("/").includes("node_modules"));
  const packages = await changedPackages(changed, manifests.map((path) => [path, () => git("show", `${head}:${path}`)]));
  if (!packages.length) {
    await writeFile(output, "");
    console.log("This PR changes no published package");
    return;
  }
  console.log(`Changed packages: ${packages.map((entry) => entry.name).join(", ")}`);
  const api = github(token);
  const services = (await deployedServices(api)).filter((service) => service.repository !== repository);
  const body = renderComment(packages, await readConsumers(api, services, watcher(packages)));
  await writeFile(output, body);
  console.log(body);
}

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
