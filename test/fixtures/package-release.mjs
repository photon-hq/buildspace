import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, publish, resolveCandidate } from "../../.github/package-release/package-release.mjs";

const SHA = "a".repeat(40);
const SUFFIX = "-staging.900.1";
const REPOSITORY = "photon-hq/adapter";
const bumpTo = (version, from = "v1.1.0") => ({ version, from, level: "minor", total: 1, changes: [{ number: 7, title: "feat: one", level: "minor" }], warnings: [] });
const BUMP = bumpTo("1.2.0");
let root;

function setUp() {
  root = mkdtempSync(join(tmpdir(), "package-release-"));
}

function tearDown() {
  rmSync(root, { recursive: true, force: true });
}

function pack(directory, manifest) {
  const source = mkdtempSync(join(root, "source-"));
  mkdirSync(join(source, "package"));
  writeFileSync(join(source, "package/package.json"), JSON.stringify(manifest));
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${manifest.name.replace(/^@/, "").replace("/", "-")}-${manifest.version}.tgz`);
  execFileSync("tar", ["-czf", file, "-C", source, "package"]);
  return file;
}

/** A `.crate` as `cargo package` lays it out, packaged from `sha`. */
function crate(directory, { name = "adapter", version = "0.4.0", sha = SHA, dirty = false, path = `crates/${name}`, lib = "pub fn adapter() {}\n", original, root: base = `${name}-${version}`, format = "gnu" } = {}) {
  const source = mkdtempSync(join(root, "crate-"));
  mkdirSync(join(source, base, "src"), { recursive: true });
  writeFileSync(join(source, base, "Cargo.toml"), `[package]\nedition = "2024"\nname = "${name}"\nversion = "${version}"\nbuild = false\n`);
  writeFileSync(join(source, base, "Cargo.toml.orig"), original ?? `[package]\nname = "${name}"\nversion = "${version}"\nedition = "2024"\n`);
  writeFileSync(join(source, base, ".cargo_vcs_info.json"), JSON.stringify({ git: { sha1: sha, ...(dirty && { dirty: true }) }, path_in_vcs: path }));
  writeFileSync(join(source, base, "src/lib.rs"), lib);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${name}-${version}.crate`);
  execFileSync("tar", [`--format=${format}`, "-czf", file, "-C", source, base]);
  return file;
}

function packBoth({ adapter = "1.2.0", core = adapter, suffix = SUFFIX, extra = {} } = {}) {
  for (const [channel, end] of [["staging", suffix], ["production", ""]]) {
    pack(join(root, channel), {
      name: "@photon-hq/adapter",
      version: `${adapter}${end}`,
      dependencies: { "@photon-hq/adapter-core": `${core}${end}` },
      ...extra,
    });
    pack(join(root, channel), { name: "@photon-hq/adapter-core", version: `${core}${end}` });
  }
}

const collectBoth = (overrides = {}) =>
  collect({
    stagingDirectory: join(root, "staging"),
    productionDirectory: join(root, "production"),
    suffix: SUFFIX,
    sourceSha: SHA,
    repository: REPOSITORY,
    packageInput: "",
    tagPrefix: "",
    bump: BUMP,
    output: join(root, "release"),
    runUrl: "https://github.com/photon-hq/adapter/actions/runs/900/attempts/1",
    ...overrides,
  });

function world({ published = {}, tags = {}, releases = {}, latest = {}, staging = {}, environment = ["octocat"], attested = true, contents = {}, history = [], runs = [] } = {}) {
  const calls = [];
  const state = { published, tags, releases };
  const http404 = (message = "gh: Not Found (HTTP 404)") => Object.assign(new Error(message), { stderr: message });
  const run = (command, args) => {
    calls.push([command, ...args]);
    const [first, second] = args;
    if (command === "npm" && first === "publish") {
      const file = args[1];
      const { name, version } = JSON.parse(execFileSync("tar", ["-xOzf", file, "package/package.json"], { encoding: "utf8" }));
      state.published[`${name}@${version}`] = `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;
      return "";
    }
    if (command === "npm" && first === "view") return JSON.stringify(state.published[second]);
    if (command === "npm" && first === "dist-tag") {
      const channel = { latest, staging }[args[3]];
      if (second === "add" && channel) channel[args[2].slice(0, args[2].lastIndexOf("@"))] = args[2].slice(args[2].lastIndexOf("@") + 1);
      return "";
    }
    if (command === "gh" && first === "api") {
      const path = args.find((arg) => arg.startsWith("repos/"));
      if (path.endsWith("/environments/production")) {
        if (!environment) throw http404();
        return JSON.stringify({ protection_rules: environment.length ? [{ type: "required_reviewers", reviewers: environment.map((login) => ({ reviewer: { login } })) }] : [] });
      }
      const content = /\/contents\/(.+)\?ref=a{40}$/.exec(path)?.[1];
      if (content) {
        if (contents[decodeURIComponent(content)] === undefined) throw http404();
        return contents[decodeURIComponent(content)];
      }
      const tag = /\/git\/ref\/tags\/(.+)$/.exec(path)?.[1];
      if (tag) {
        if (!state.tags[tag]) throw http404();
        return JSON.stringify({ object: { type: "commit", sha: state.tags[tag] } });
      }
      if (path.endsWith("/git/refs")) {
        const ref = args.find((arg) => arg.startsWith("ref=")).slice("ref=refs/tags/".length);
        state.tags[ref] = args.find((arg) => arg.startsWith("sha=")).slice(4);
        return "";
      }
      const prefix = /\/git\/matching-refs\/tags\/([^?]*)\?/.exec(path)?.[1];
      if (prefix !== undefined)
        return JSON.stringify(
          Object.entries(state.tags)
            .filter(([name]) => name.startsWith(prefix))
            .map(([name, sha]) => ({ ref: `refs/tags/${name}`, object: { type: "commit", sha } }))
        );
      // `history` lists main's commits, oldest first.
      const compared = /\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})$/.exec(path);
      if (compared) {
        const [base, head] = [history.indexOf(compared[1]), history.indexOf(compared[2])];
        const status = base < 0 || head < 0 ? "diverged" : base < head ? "ahead" : base > head ? "behind" : "identical";
        return JSON.stringify({ status });
      }
      if (/\/actions\/runs\/\d+$/.test(path)) return JSON.stringify({ workflow_id: 7 });
      if (/\/actions\/workflows\/7\/runs\?/.test(path)) return JSON.stringify({ workflow_runs: runs });
      if (/\/compare\/a{40}\.\.\.main$/.test(path)) return JSON.stringify({ status: "ahead" });
      if (/\/compare\/(?:[a-z0-9._-]+-)?v[^.]+.*\.\.\.a{40}$/.test(path))
        return JSON.stringify({ total_commits: 2, commits: [{ commit: { message: "feat: one\n\nbody" } }, { commit: { message: "fix: two" } }] });
    }
    if (command === "gh" && first === "release") {
      const tag = args[2];
      const release = state.releases[tag];
      if (second === "view") {
        if (!release) throw http404("release not found");
        return JSON.stringify({ isPrerelease: release.prerelease, assets: release.assets.map((name) => ({ name })) });
      }
      if (second === "create") {
        const files = args.slice(3, args.indexOf("--repo"));
        state.releases[tag] = { prerelease: args.includes("--prerelease"), assets: files.map((file) => file.split("/").at(-1)), files, notes: readFileSync(args[args.indexOf("--notes-file") + 1], "utf8"), title: args[args.indexOf("--title") + 1] };
        return "";
      }
      if (second === "upload") {
        release.assets.push(...args.slice(3, args.indexOf("--repo")).map((file) => file.split("/").at(-1)));
        return "";
      }
      if (second === "download") {
        if (!release) throw http404("release not found");
        const pattern = args[args.indexOf("--pattern") + 1];
        const source = release.files.find((file) => file.endsWith(`/${pattern}`));
        if (!source) throw http404("no assets match the file pattern");
        writeFileSync(join(args[args.indexOf("--dir") + 1], pattern), readFileSync(source));
        return "";
      }
    }
    if (command === "gh" && first === "attestation") {
      if (!attested) throw Object.assign(new Error("verification failed"), { stderr: "no attestations" });
      return "";
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
  const registry = async (name) => {
    const versions = {};
    for (const [key, value] of Object.entries(state.published)) {
      const at = key.lastIndexOf("@");
      if (key.slice(0, at) === name) versions[key.slice(at + 1)] = { dist: { integrity: value } };
    }
    const tags = {};
    if (latest[name]) tags.latest = latest[name];
    if (staging[name]) tags.staging = staging[name];
    return { versions, "dist-tags": tags };
  };
  return { calls, state, run, registry };
}

const commands = (calls, command, first) => calls.filter((call) => call[0] === command && call[1] === first);
const publishWith = (fake, overrides = {}) =>
  publish({
    directory: join(root, "release"),
    channel: "staging",
    repository: REPOSITORY,
    sourceSha: SHA,
    packageInput: "",
    tagPrefix: "",
    runId: "900",
    runAttempt: "1",
    ...(overrides.channel !== "production" && { bump: BUMP }),
    run: fake.run,
    registry: fake.registry,
    log: () => {},
    ...overrides,
  });

async function stagedWorld(options = {}) {
  packBoth(options.pack);
  for (const spec of options.crates ?? []) crate(join(root, "crates"), spec);
  const crates = (options.crates ?? []).map(({ name = "adapter" }) => name);
  const manifest = await collectBoth({ crates, crateDirectory: join(root, "crates"), ...options.names });
  const fake = world({ ...options.world, staging: { "@photon-hq/adapter": `1.2.0${SUFFIX}` } });
  await publishWith(fake, { crates, ...options.names });
  fake.calls.length = 0;
  return { manifest, fake };
}

const resolveWith = (fake, overrides = {}) =>
  resolveCandidate({
    repository: REPOSITORY,
    packageInput: "",
    tagPrefix: "",
    version: "",
    environment: "production",
    signerWorkflow: "photon-hq/buildspace/.github/workflows/package-stage.yml",
    output: join(root, "candidate"),
    run: fake.run,
    registry: fake.registry,
    ...overrides,
  });

function asLegacy() {
  const path = join(root, "release/release-manifest.json");
  const { bump: _bump, selection: _selection, ...manifest } = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...manifest, formatVersion: 2 }));
}


export { SHA, SUFFIX, REPOSITORY, bumpTo, BUMP, root, setUp, tearDown, pack, crate, packBoth, collectBoth, world, commands, publishWith, stagedWorld, resolveWith, asLegacy };
