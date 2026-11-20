import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import {
  collect,
  publish,
  resolveCandidate,
} from "../../.github/package-release/package-release.mjs";

const SHA = "a".repeat(40);
const SUFFIX = "-staging.900.1";
const REPOSITORY = "photon-hq/adapter";

const bumpTo = (version, from = "v1.1.0") => ({
  version,
  from,
  level: "minor",
  total: 1,
  changes: [{ number: 7, title: "feat: one", level: "minor" }],
  warnings: [],
});

const BUMP = bumpTo("1.2.0");
let root;

const fixturePath = (...parts) => nodePath.join(root, ...parts);

const setUp = () => {
  root = mkdtempSync(nodePath.join(tmpdir(), "package-release-"));
};

const tearDown = () => {
  rmSync(root, { recursive: true, force: true });
};

const pack = (directory, manifest) => {
  const source = mkdtempSync(nodePath.join(root, "source-"));
  mkdirSync(nodePath.join(source, "package"));
  writeFileSync(
    nodePath.join(source, "package/package.json"),
    JSON.stringify(manifest)
  );
  mkdirSync(directory, { recursive: true });

  const file = nodePath.join(
    directory,
    `${manifest.name.replace(/^@/, "").replace("/", "-")}-${manifest.version}.tgz`
  );

  execFileSync("tar", ["-czf", file, "-C", source, "package"]);

  return file;
};

/** A `.crate` as `cargo package` lays it out, packaged from `sha`. */
const crate = (
  directory,
  {
    name = "adapter",
    version = "0.4.0",
    sha = SHA,
    dirty = false,
    path = `crates/${name}`,
    lib = "pub fn adapter() {}\n",
    original,
    root: base = `${name}-${version}`,
    format = "gnu",
  } = {}
) => {
  const source = mkdtempSync(nodePath.join(root, "crate-"));
  mkdirSync(nodePath.join(source, base, "src"), { recursive: true });
  writeFileSync(
    nodePath.join(source, base, "Cargo.toml"),
    `[package]\nedition = "2024"\nname = "${name}"\nversion = "${version}"\nbuild = false\n`
  );
  writeFileSync(
    nodePath.join(source, base, "Cargo.toml.orig"),
    original ??
      `[package]\nname = "${name}"\nversion = "${version}"\nedition = "2024"\n`
  );
  writeFileSync(
    nodePath.join(source, base, ".cargo_vcs_info.json"),
    JSON.stringify({
      git: { sha1: sha, ...(dirty && { dirty: true }) },
      path_in_vcs: path,
    })
  );
  writeFileSync(nodePath.join(source, base, "src/lib.rs"), lib);
  mkdirSync(directory, { recursive: true });
  const file = nodePath.join(directory, `${name}-${version}.crate`);
  execFileSync("tar", [`--format=${format}`, "-czf", file, "-C", source, base]);

  return file;
};

const packBoth = ({
  adapter = "1.2.0",
  core = adapter,
  suffix = SUFFIX,
  extra = {},
} = {}) => {
  for (const [channel, end] of [
    ["staging", suffix],
    ["production", ""],
  ]) {
    pack(nodePath.join(root, channel), {
      name: "@photon-hq/adapter",
      version: `${adapter}${end}`,
      dependencies: { "@photon-hq/adapter-core": `${core}${end}` },
      ...extra,
    });
    pack(nodePath.join(root, channel), {
      name: "@photon-hq/adapter-core",
      version: `${core}${end}`,
    });
  }
};

const collectBoth = (overrides = {}) =>
  collect({
    stagingDirectory: nodePath.join(root, "staging"),
    productionDirectory: nodePath.join(root, "production"),
    suffix: SUFFIX,
    sourceSha: SHA,
    repository: REPOSITORY,
    packageInput: "",
    tagPrefix: "",
    bump: BUMP,
    output: nodePath.join(root, "release"),
    runUrl: "https://github.com/photon-hq/adapter/actions/runs/900/attempts/1",
    ...overrides,
  });

const commandError = (command, args) =>
  new Error(`Unexpected command: ${command} ${args.join(" ")}`);

const http404 = (message = "gh: Not Found (HTTP 404)") =>
  Object.assign(new Error(message), { stderr: message });

const npmCommand = (args, { published, latest, staging }) => {
  const [operation, target, spec, channelName] = args;

  if (operation === "publish") {
    const { name, version } = JSON.parse(
      execFileSync("tar", ["-xOzf", target, "package/package.json"], {
        encoding: "utf-8",
      })
    );

    published[`${name}@${version}`] =
      `sha512-${createHash("sha512").update(readFileSync(target)).digest("base64")}`;

    return "";
  }

  if (operation === "view") {
    return JSON.stringify(published[target]);
  }

  if (operation === "dist-tag") {
    const channel = { latest, staging }[channelName];

    if (target === "add" && channel) {
      const separator = spec.lastIndexOf("@");
      channel[spec.slice(0, separator)] = spec.slice(separator + 1);
    }

    return "";
  }

  throw commandError("npm", args);
};

const compareCommits = (history, { base, head }) => {
  const baseIndex = history.indexOf(base);
  const headIndex = history.indexOf(head);

  if (baseIndex === -1 || headIndex === -1) {
    return "diverged";
  }

  if (baseIndex === headIndex) {
    return "identical";
  }

  return baseIndex < headIndex ? "ahead" : "behind";
};

const githubApi = (args, { environment, contents, tags, history, runs }) => {
  const request = args.find((arg) => arg.startsWith("repos/"));

  if (request.endsWith("/environments/production")) {
    if (!environment) {
      throw http404();
    }

    return JSON.stringify({
      protection_rules: environment.length
        ? [
            {
              type: "required_reviewers",
              reviewers: environment.map((login) => ({
                reviewer: { login },
              })),
            },
          ]
        : [],
    });
  }

  const content = /\/contents\/(?<file>.+)\?ref=a{40}$/.exec(request)?.groups
    .file;

  if (content) {
    const result = contents[decodeURIComponent(content)];

    if (result === undefined) {
      throw http404();
    }

    return result;
  }

  const tag = /\/git\/ref\/tags\/(?<name>.+)$/.exec(request)?.groups.name;

  if (tag) {
    if (!tags[tag]) {
      throw http404();
    }

    return JSON.stringify({ object: { type: "commit", sha: tags[tag] } });
  }

  if (request.endsWith("/git/refs")) {
    const ref = args
      .find((arg) => arg.startsWith("ref="))
      .slice("ref=refs/tags/".length);

    tags[ref] = args.find((arg) => arg.startsWith("sha=")).slice(4);

    return "";
  }

  const prefix = /\/git\/matching-refs\/tags\/(?<prefix>[^?]*)\?/.exec(request)
    ?.groups.prefix;

  if (prefix !== undefined) {
    return JSON.stringify(
      Object.entries(tags)
        .filter(([name]) => name.startsWith(prefix))
        .map(([name, sha]) => ({
          ref: `refs/tags/${name}`,
          object: { type: "commit", sha },
        }))
    );
  }

  // `history` lists main's commits, oldest first.
  const compared =
    /\/compare\/(?<base>[a-f0-9]{40})\.\.\.(?<head>[a-f0-9]{40})$/.exec(
      request
    )?.groups;

  if (compared) {
    return JSON.stringify({ status: compareCommits(history, compared) });
  }

  if (/\/actions\/runs\/\d+$/.test(request)) {
    return JSON.stringify({ workflow_id: 7 });
  }

  if (/\/actions\/workflows\/7\/runs\?/.test(request)) {
    return JSON.stringify({ workflow_runs: runs });
  }

  if (/\/compare\/a{40}\.\.\.main$/.test(request)) {
    return JSON.stringify({ status: "ahead" });
  }

  if (
    /\/compare\/(?:[a-z0-9._-]+-)?v[^.]+(?:\..*)?\.\.\.a{40}$/.test(request)
  ) {
    return JSON.stringify({
      total_commits: 2,
      commits: [
        { commit: { message: "feat: one\n\nbody" } },
        { commit: { message: "fix: two" } },
      ],
    });
  }

  throw commandError("gh", args);
};

const githubRelease = (args, releases) => {
  const [, operation, tag] = args;
  const release = releases[tag];

  if (operation === "view") {
    if (!release) {
      throw http404("release not found");
    }

    return JSON.stringify({
      isPrerelease: release.prerelease,
      assets: release.assets.map((name) => ({ name })),
    });
  }

  if (operation === "create") {
    const files = args.slice(3, args.indexOf("--repo"));
    releases[tag] = {
      prerelease: args.includes("--prerelease"),
      assets: files.map((file) => file.split("/").at(-1)),
      files,
      notes: readFileSync(args[args.indexOf("--notes-file") + 1], "utf-8"),
      title: args[args.indexOf("--title") + 1],
    };

    return "";
  }

  if (operation === "upload") {
    release.assets.push(
      ...args
        .slice(3, args.indexOf("--repo"))
        .map((file) => file.split("/").at(-1))
    );

    return "";
  }

  if (operation === "download") {
    if (!release) {
      throw http404("release not found");
    }

    const pattern = args[args.indexOf("--pattern") + 1];
    const source = release.files.find((file) => file.endsWith(`/${pattern}`));

    if (!source) {
      throw http404("no assets match the file pattern");
    }

    writeFileSync(
      nodePath.join(args[args.indexOf("--dir") + 1], pattern),
      readFileSync(source)
    );

    return "";
  }

  throw commandError("gh", args);
};

const world = ({
  published = {},
  tags = {},
  releases = {},
  latest = {},
  staging = {},
  environment = ["octocat"],
  attested = true,
  contents = {},
  history = [],
  runs = [],
} = {}) => {
  const calls = [];
  const state = { published, tags, releases };

  const run = (command, args) => {
    calls.push([command, ...args]);
    const [operation] = args;

    if (command === "npm") {
      return npmCommand(args, { published: state.published, latest, staging });
    }

    if (command === "gh" && operation === "api") {
      return githubApi(args, {
        environment,
        contents,
        tags: state.tags,
        history,
        runs,
      });
    }

    if (command === "gh" && operation === "release") {
      return githubRelease(args, state.releases);
    }

    if (command === "gh" && operation === "attestation") {
      if (!attested) {
        throw Object.assign(new Error("verification failed"), {
          stderr: "no attestations",
        });
      }

      return "";
    }

    throw commandError(command, args);
  };

  const registry = async (name) => {
    const versions = {};

    for (const [key, value] of Object.entries(state.published)) {
      const at = key.lastIndexOf("@");

      if (key.slice(0, at) === name) {
        versions[key.slice(at + 1)] = { dist: { integrity: value } };
      }
    }

    const channelTags = {
      ...(latest[name] && { latest: latest[name] }),
      ...(staging[name] && { staging: staging[name] }),
    };

    return { versions, "dist-tags": channelTags };
  };

  return { calls, state, run, registry };
};

const commands = (calls, command, first) =>
  calls.filter((call) => call[0] === command && call[1] === first);

const publishWith = (fake, overrides = {}) =>
  publish({
    directory: nodePath.join(root, "release"),
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
    log: () => undefined,
    ...overrides,
  });

const stagedWorld = async (options = {}) => {
  packBoth(options.pack);

  for (const spec of options.crates ?? []) {
    crate(nodePath.join(root, "crates"), spec);
  }

  const crates = (options.crates ?? []).map(({ name = "adapter" }) => name);

  const manifest = await collectBoth({
    crates,
    crateDirectory: nodePath.join(root, "crates"),
    ...options.names,
  });

  const fake = world({
    ...options.world,
    staging: { "@photon-hq/adapter": `1.2.0${SUFFIX}` },
  });

  await publishWith(fake, { crates, ...options.names });
  fake.calls.length = 0;

  return { manifest, fake };
};

const resolveWith = (fake, overrides = {}) =>
  resolveCandidate({
    repository: REPOSITORY,
    packageInput: "",
    tagPrefix: "",
    version: "",
    environment: "production",
    signerWorkflow: "photon-hq/buildspace/.github/workflows/package-stage.yml",
    output: nodePath.join(root, "candidate"),
    run: fake.run,
    registry: fake.registry,
    ...overrides,
  });

const asLegacy = () => {
  const path = nodePath.join(root, "release/release-manifest.json");

  const {
    bump: _bump,
    selection: _selection,
    ...manifest
  } = JSON.parse(readFileSync(path, "utf-8"));

  writeFileSync(path, JSON.stringify({ ...manifest, formatVersion: 2 }));
};

export {
  SHA,
  SUFFIX,
  REPOSITORY,
  bumpTo,
  BUMP,
  fixturePath,
  setUp,
  tearDown,
  pack,
  crate,
  packBoth,
  collectBoth,
  world,
  commands,
  publishWith,
  stagedWorld,
  resolveWith,
  asLegacy,
};
