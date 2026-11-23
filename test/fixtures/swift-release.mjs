import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, publish, resolveCandidate } from "../../.github/package-release/swift-release.mjs";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const SUFFIX = "-staging.900.1";
const REPOSITORY = "photon-hq/macrocosm-astrolabe";
const NAME = "macrocosm-astrolabe";
const SIGNER = "photon-hq/buildspace/.github/workflows/swift-stage.yml";
const BUMP = { version: "1.27.0", from: "v1.26.0", level: "minor", total: 1, changes: [{ number: 91, title: "feat: stage every main push", level: "minor" }], warnings: [] };
let root;

function setUp() {
  root = mkdtempSync(join(tmpdir(), "swift-release-"));
}

function tearDown() {
  rmSync(root, { recursive: true, force: true });
}

const sha = (digit) => digit.repeat(40);

/** The two packages pkgbuild wrote: they differ only in the version they were built at. */
function packages() {
  for (const channel of ["staging", "production"]) {
    mkdirSync(join(root, "pack", channel), { recursive: true });
    writeFileSync(join(root, "pack", channel, `${NAME}.pkg`), `xar ${channel}`);
  }
}

const collectBuild = (overrides = {}) =>
  collect({
    stagingPackage: join(root, "pack/staging", `${NAME}.pkg`),
    productionPackage: join(root, "pack/production", `${NAME}.pkg`),
    packageName: NAME,
    bump: BUMP,
    suffix: SUFFIX,
    sourceSha: SHA,
    repository: REPOSITORY,
    output: join(root, "release"),
    runUrl: `https://github.com/${REPOSITORY}/actions/runs/900/attempts/1`,
    ...overrides,
  });

const MANIFEST_ONLY = '// swift-tools-version: 6.2\nimport PackageDescription\n\nlet package = Package(name: "macrocosm-astrolabe")\n';

/**
 * A fake GitHub that records every command. `files` are the source commit's;
 * `repos` are the owner's other repositories, a private one readable only
 * through `dependencyRun`, which holds the dependency token. `soak` holds the
 * commits since the latest release, oldest first, with their pull requests,
 * and when each release was published.
 */
function world({ tags = {}, releases = {}, environment = ["octocat"], attested = true, onMain = true, files = { "Package.swift": MANIFEST_ONLY }, repos = {}, soak = {} } = {}) {
  const { commits = [], published = {}, forbidden = "", drafts = [], stable = [] } = soak;
  const calls = [];
  const state = { tags, releases };
  const fail = (message) => Object.assign(new Error(message), { stderr: message });
  const missing = () => fail("gh: Not Found (HTTP 404)");
  const handle = (command, args, privileged) => {
    calls.push([command, ...args]);
    const [first, second] = args;
    if (command === "gh" && first === "api") {
      const path = args.find((arg) => arg.startsWith("repos/"));
      const content = /^repos\/([^/]+\/[^/]+)\/contents\/(.+)\?ref=([a-f0-9]{40})$/.exec(path);
      if (content) {
        if (content[1] !== REPOSITORY || content[3] !== SHA || !(content[2] in files)) throw missing();
        return files[content[2]];
      }
      const [, owner, rest] = /^repos\/([^/]+\/[^/]+)(.*)$/.exec(path);
      if (owner !== REPOSITORY) {
        const repo = repos[owner];
        if (!repo || (repo.private && !privileged)) throw missing();
        if (!rest) return JSON.stringify({ full_name: owner });
        const named = /^\/(?:releases\/tags|git\/ref\/tags)\/(.+)$/.exec(rest)?.[1];
        const release = repo.releases[named];
        if (!release) throw missing();
        if (rest.startsWith("/releases/")) return JSON.stringify({ tag_name: named, draft: Boolean(release.draft), prerelease: Boolean(release.prerelease) });
        return JSON.stringify({ object: { type: "commit", sha: release.sha } });
      }
      if (path.endsWith("/environments/production")) {
        if (!environment) throw fail("gh: Not Found (HTTP 404)");
        return JSON.stringify({ protection_rules: environment.length ? [{ type: "required_reviewers", reviewers: environment }] : [] });
      }
      if (/\/git\/matching-refs\/tags\/v$/.test(path))
        return JSON.stringify(Object.entries(state.tags).filter(([name]) => name.startsWith("v")).map(([name, sha]) => ({ ref: `refs/tags/${name}`, object: { type: "commit", sha } })));
      const tag = /\/git\/ref\/tags\/(.+)$/.exec(path)?.[1];
      if (tag) {
        if (!state.tags[tag]) throw fail("gh: Not Found (HTTP 404)");
        return JSON.stringify({ object: { type: "commit", sha: state.tags[tag] } });
      }
      if (path.endsWith("/git/refs")) {
        state.tags[args.find((arg) => arg.startsWith("ref=")).slice("ref=refs/tags/".length)] = args.find((arg) => arg.startsWith("sha=")).slice(4);
        return "";
      }
      if (/\/compare\/[a-f0-9]{40}\.\.\.main$/.test(path)) return JSON.stringify({ status: onMain ? "ahead" : "diverged" });
      const range = /\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})\?per_page=100&page=(\d+)$/.exec(path);
      if (range) {
        // The commits after the base (all of them for a base before the list) up to the head.
        const carried = commits.slice(commits.findIndex(({ sha }) => sha === range[1]) + 1, commits.findIndex(({ sha }) => sha === range[2]) + 1);
        const page = carried.slice((Number(range[3]) - 1) * 100, Number(range[3]) * 100);
        return JSON.stringify({ total_commits: carried.length, commits: page.map(({ sha, message = "" }) => ({ sha, commit: { message } })) });
      }
      const single = /\/commits\/([a-f0-9]{40})$/.exec(path);
      if (single) {
        const found = commits.find(({ sha }) => sha === single[1]);
        if (!found) throw missing();
        return JSON.stringify({ sha: found.sha, commit: { message: found.message ?? "" } });
      }
      const pulls = /\/commits\/([a-f0-9]{40})\/pulls$/.exec(path);
      if (pulls) {
        if (forbidden) throw fail(forbidden);
        const found = commits.find(({ sha }) => sha === pulls[1]);
        const listed = [...(found?.otherPulls ?? []), ...(found?.pull ? [found.pull] : [])];
        return JSON.stringify(listed.map((pull) => ({ merged_at: "2026-01-14T00:00:00Z", base: { ref: "main" }, ...pull, labels: (pull.labels ?? []).map((name) => ({ name })) })));
      }
      const released = /\/releases\/tags\/(.+)$/.exec(path)?.[1];
      if (released) {
        if (!state.releases[released] && !(released in published)) throw missing();
        const prerelease = !stable.includes(released) && (state.releases[released]?.prerelease ?? released.includes("-"));
        return JSON.stringify({ tag_name: released, draft: drafts.includes(released), prerelease, published_at: published[released] ?? null });
      }
    }
    if (command === "gh" && first === "release") {
      const tag = args[2];
      const release = state.releases[tag];
      if (second === "view") {
        if (!release) throw fail("release not found");
        return JSON.stringify({ isPrerelease: release.prerelease, assets: release.assets.map((name) => ({ name })) });
      }
      if (second === "create") {
        const files = args.slice(3, args.indexOf("--repo"));
        state.releases[tag] = { prerelease: args.includes("--prerelease"), files, assets: files.map((file) => file.split("/").at(-1)), title: args[args.indexOf("--title") + 1], notes: readFileSync(args[args.indexOf("--notes-file") + 1], "utf8") };
        return "";
      }
      if (second === "download") {
        if (!release) throw fail("release not found");
        const pattern = args[args.indexOf("--pattern") + 1];
        const source = release.files.find((file) => file.endsWith(`/${pattern}`));
        if (!source) throw fail("no assets match the file pattern");
        writeFileSync(join(args[args.indexOf("--dir") + 1], pattern), readFileSync(source));
        return "";
      }
    }
    if (command === "gh" && first === "attestation") {
      if (!attested) throw fail("verification failed");
      return "";
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
  return { calls, state, run: (command, args) => handle(command, args, false), dependencyRun: (command, args) => handle(command, args, true) };
}

const commands = (calls, first) => calls.filter((call) => call[0] === "gh" && call[1] === first);
const publishWith = (fake, overrides = {}) =>
  publish({
    directory: join(root, "release"),
    channel: "staging",
    repository: REPOSITORY,
    sourceSha: SHA,
    packageName: NAME,
    runId: "900",
    ...(overrides.channel !== "production" && { bump: BUMP }),
    run: fake.run,
    ...overrides,
  });
const resolveWith = (fake, overrides = {}) =>
  resolveCandidate({
    repository: REPOSITORY,
    packageName: NAME,
    environment: "production",
    signerWorkflow: SIGNER,
    output: join(root, "candidate"),
    run: fake.run,
    ...overrides,
  });

/** A build staged by an earlier main push, as the stage workflow left it. */
async function staged(options = {}) {
  packages();
  const manifest = await collectBuild(options.collect);
  const fake = world({ tags: { "v1.26.0": OTHER, "v1.26.1-rc.3": OTHER }, ...options.world });
  await publishWith(fake, options.collect);
  fake.calls.length = 0;
  return { manifest, fake };
}

export { SHA, OTHER, SUFFIX, REPOSITORY, NAME, SIGNER, BUMP, root, setUp, tearDown, sha, packages, collectBuild, world, commands, publishWith, resolveWith, staged };
