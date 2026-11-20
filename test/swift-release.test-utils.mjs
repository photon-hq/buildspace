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
} from "../.github/package-release/swift-release.mjs";

export const SHA = "a".repeat(40);
export const OTHER = "b".repeat(40);
export const SUFFIX = "-staging.900.1";
export const REPOSITORY = "photon-hq/macrocosm-astrolabe";
export const NAME = "macrocosm-astrolabe";
export const SIGNER = "photon-hq/buildspace/.github/workflows/swift-stage.yml";

export const BUMP = {
  version: "1.27.0",
  from: "v1.26.0",
  level: "minor",
  total: 1,
  changes: [
    { number: 91, title: "feat: stage every main push", level: "minor" },
  ],
  warnings: [],
};

const MANIFEST_ONLY =
  '// swift-tools-version: 6.2\nimport PackageDescription\n\nlet package = Package(name: "macrocosm-astrolabe")\n';

const fail = (message) =>
  Object.assign(new Error(message), { stderr: message });

const missing = () => fail("gh: Not Found (HTTP 404)");

const unexpectedCommand = (command, args) =>
  new Error(`Unexpected command: ${command} ${args.join(" ")}`);

const handleDependencyApi = (repos, owner, rest, privileged) => {
  const repo = repos[owner];

  if (!repo || (repo.private && !privileged)) {
    throw missing();
  }

  if (!rest) {
    return JSON.stringify({ full_name: owner });
  }

  const named = /^\/(?:releases\/tags|git\/ref\/tags)\/(?<tag>.+)$/.exec(rest)
    ?.groups.tag;

  const release = repo.releases[named];

  if (!release) {
    throw missing();
  }

  if (rest.startsWith("/releases/")) {
    return JSON.stringify({
      tag_name: named,
      draft: Boolean(release.draft),
      prerelease: Boolean(release.prerelease),
    });
  }

  return JSON.stringify({ object: { type: "commit", sha: release.sha } });
};

const releaseByTagResponse = (tag, { published, drafts, stable, state }) => {
  if (!state.releases[tag] && !(tag in published)) {
    throw missing();
  }

  const prerelease =
    !stable.includes(tag) &&
    (state.releases[tag]?.prerelease ?? tag.includes("-"));

  return JSON.stringify({
    tag_name: tag,
    draft: drafts.includes(tag),
    prerelease,
    published_at: published[tag] ?? null,
  });
};

const handleSoakApi = (route, context) => {
  const { commits, forbidden } = context;

  const range =
    /\/compare\/(?<base>[a-f0-9]{40})\.\.\.(?<head>[a-f0-9]{40})\?per_page=100&page=(?<page>\d+)$/.exec(
      route
    )?.groups;

  if (range) {
    // The commits after the base (all of them for a base before the list) up to the head.
    const carried = commits.slice(
      commits.findIndex(({ sha }) => sha === range.base) + 1,
      commits.findIndex(({ sha }) => sha === range.head) + 1
    );

    const page = carried.slice(
      (Number(range.page) - 1) * 100,
      Number(range.page) * 100
    );

    return JSON.stringify({
      total_commits: carried.length,
      commits: page.map(({ sha, message = "" }) => ({
        sha,
        commit: { message },
      })),
    });
  }

  const single = /\/commits\/(?<sha>[a-f0-9]{40})$/.exec(route)?.groups;

  if (single) {
    const found = commits.find(({ sha }) => sha === single.sha);

    if (!found) {
      throw missing();
    }

    return JSON.stringify({
      sha: found.sha,
      commit: { message: found.message ?? "" },
    });
  }

  const pulls = /\/commits\/(?<sha>[a-f0-9]{40})\/pulls$/.exec(route)?.groups;

  if (pulls) {
    if (forbidden) {
      throw fail(forbidden);
    }

    const found = commits.find(({ sha }) => sha === pulls.sha);

    const listed = [
      ...(found?.otherPulls ?? []),
      ...(found?.pull ? [found.pull] : []),
    ];

    return JSON.stringify(
      listed.map((pull) => ({
        merged_at: "2026-01-14T00:00:00Z",
        base: { ref: "main" },
        ...pull,
        labels: (pull.labels ?? []).map((name) => ({ name })),
      }))
    );
  }

  const released = /\/releases\/tags\/(?<tag>.+)$/.exec(route)?.groups.tag;

  if (released) {
    return releaseByTagResponse(released, context);
  }
};

const handleApi = (args, privileged, context) => {
  const { files, repos, environment, onMain, state } = context;

  const route = args.find((arg) => arg.startsWith("repos/"));

  const content =
    /^repos\/(?<owner>[^/]+\/[^/]+)\/contents\/(?<file>.+)\?ref=(?<sha>[a-f0-9]{40})$/.exec(
      route
    )?.groups;

  if (content) {
    if (
      content.owner !== REPOSITORY ||
      content.sha !== SHA ||
      !(content.file in files)
    ) {
      throw missing();
    }

    return files[content.file];
  }

  const {
    groups: { owner, rest },
  } = /^repos\/(?<owner>[^/]+\/[^/]+)(?<rest>(?:\/.*)?)$/.exec(route);

  if (owner !== REPOSITORY) {
    return handleDependencyApi(repos, owner, rest, privileged);
  }

  if (route.endsWith("/environments/production")) {
    if (!environment) {
      throw missing();
    }

    return JSON.stringify({
      protection_rules: environment.length
        ? [{ type: "required_reviewers", reviewers: environment }]
        : [],
    });
  }

  if (route.endsWith("/git/matching-refs/tags/v")) {
    return JSON.stringify(
      Object.entries(state.tags)
        .filter(([name]) => name.startsWith("v"))
        .map(([name, sha]) => ({
          ref: `refs/tags/${name}`,
          object: { type: "commit", sha },
        }))
    );
  }

  const tag = /\/git\/ref\/tags\/(?<tag>.+)$/.exec(route)?.groups.tag;

  if (tag) {
    if (!state.tags[tag]) {
      throw missing();
    }

    return JSON.stringify({
      object: { type: "commit", sha: state.tags[tag] },
    });
  }

  if (route.endsWith("/git/refs")) {
    state.tags[
      args.find((arg) => arg.startsWith("ref=")).slice("ref=refs/tags/".length)
    ] = args.find((arg) => arg.startsWith("sha=")).slice(4);

    return "";
  }

  if (/\/compare\/[a-f0-9]{40}\.\.\.main$/.test(route)) {
    return JSON.stringify({ status: onMain ? "ahead" : "diverged" });
  }

  const response = handleSoakApi(route, context);

  if (response !== undefined) {
    return response;
  }

  throw unexpectedCommand("gh", args);
};

const handleRelease = (args, state) => {
  const [, action, tag] = args;
  const release = state.releases[tag];

  if (action === "view") {
    if (!release) {
      throw fail("release not found");
    }

    return JSON.stringify({
      isPrerelease: release.prerelease,
      assets: release.assets.map((name) => ({ name })),
    });
  }

  if (action === "create") {
    const files = args.slice(3, args.indexOf("--repo"));
    state.releases[tag] = {
      prerelease: args.includes("--prerelease"),
      files,
      assets: files.map((file) => file.split("/").at(-1)),
      title: args[args.indexOf("--title") + 1],
      notes: readFileSync(args[args.indexOf("--notes-file") + 1], "utf-8"),
    };

    return "";
  }

  if (action === "download") {
    if (!release) {
      throw fail("release not found");
    }

    const pattern = args[args.indexOf("--pattern") + 1];

    const source = release.files.find((file) => file.endsWith(`/${pattern}`));

    if (!source) {
      throw fail("no assets match the file pattern");
    }

    writeFileSync(
      nodePath.join(args[args.indexOf("--dir") + 1], pattern),
      readFileSync(source)
    );

    return "";
  }

  throw unexpectedCommand("gh", args);
};

/**
 * A fake GitHub that records every command. `files` are the source commit's;
 * `repos` are the owner's other repositories, a private one readable only
 * through `dependencyRun`, which holds the dependency token. `soak` holds the
 * commits since the latest release, oldest first, with their pull requests,
 * and when each release was published.
 */
export const world = ({
  tags = {},
  releases = {},
  environment = ["octocat"],
  attested = true,
  onMain = true,
  files = { "Package.swift": MANIFEST_ONLY },
  repos = {},
  soak = {},
} = {}) => {
  const {
    commits = [],
    published = {},
    forbidden = "",
    drafts = [],
    stable = [],
  } = soak;

  const calls = [];
  const state = { tags, releases };

  const apiContext = {
    commits,
    published,
    forbidden,
    drafts,
    stable,
    files,
    repos,
    environment,
    onMain,
    state,
  };

  const handle = (command, args, privileged) => {
    calls.push([command, ...args]);
    const [first] = args;

    if (command === "gh" && first === "api") {
      return handleApi(args, privileged, apiContext);
    }

    if (command === "gh" && first === "release") {
      return handleRelease(args, state);
    }

    if (command === "gh" && first === "attestation") {
      if (!attested) {
        throw fail("verification failed");
      }

      return "";
    }

    throw unexpectedCommand(command, args);
  };

  return {
    calls,
    state,
    run: (command, args) => handle(command, args, false),
    dependencyRun: (command, args) => handle(command, args, true),
  };
};

export const makeSha = (digit) => digit.repeat(40);

export const T0 = Date.parse("2026-01-15T12:00:00Z");
export const at = (minutes) => new Date(T0 + minutes * 60_000).toISOString();
export const C1 = makeSha("1");
export const C2 = makeSha("2");
export const OWN = `v1.27.0${SUFFIX}`;
export const EARLIER = "v1.27.0-staging.850.1";

export const swiftReleaseFixture = () => {
  let root;

  const createDirectory = () => {
    root = mkdtempSync(nodePath.join(tmpdir(), "swift-release-"));
  };

  const removeDirectory = () => rmSync(root, { recursive: true, force: true });
  const fixturePath = (...parts) => nodePath.join(root, ...parts);

  /** The two packages pkgbuild wrote: they differ only in the version they were built at. */
  const packages = () => {
    for (const channel of ["staging", "production"]) {
      mkdirSync(fixturePath("pack", channel), { recursive: true });
      writeFileSync(
        fixturePath("pack", channel, `${NAME}.pkg`),
        `xar ${channel}`
      );
    }
  };

  const collectBuild = (overrides = {}) =>
    collect({
      stagingPackage: fixturePath("pack/staging", `${NAME}.pkg`),
      productionPackage: fixturePath("pack/production", `${NAME}.pkg`),
      packageName: NAME,
      bump: BUMP,
      suffix: SUFFIX,
      sourceSha: SHA,
      repository: REPOSITORY,
      output: fixturePath("release"),
      runUrl: `https://github.com/${REPOSITORY}/actions/runs/900/attempts/1`,
      ...overrides,
    });

  const publishWith = (fake, overrides = {}) =>
    publish({
      directory: fixturePath("release"),
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
      output: fixturePath("candidate"),
      run: fake.run,
      ...overrides,
    });

  /** A build staged by an earlier main push, as the stage workflow left it. */
  const staged = async (options = {}) => {
    packages();
    const manifest = await collectBuild(options.collect);

    const fake = world({
      tags: { "v1.26.0": OTHER, "v1.26.1-rc.3": OTHER },
      ...options.world,
    });

    await publishWith(fake, options.collect);
    fake.calls.length = 0;

    return { manifest, fake };
  };

  /**
   * Two changes since v1.26.0: #95 at C1, staged as EARLIER at T0, and #96 at
   * SHA, the candidate, staged 50 minutes later.
   */
  const soaking = ({ labels = {}, published = {}, commits, ...rest } = {}) =>
    staged({
      world: {
        tags: { "v1.26.0": OTHER, [EARLIER]: C1 },
        soak: {
          commits: commits ?? [
            {
              sha: C1,
              message: "fix: drain the queue\n\nbody",
              pull: {
                number: 95,
                title: "fix: drain the queue",
                labels: labels[95],
              },
            },
            {
              sha: SHA,
              message: "feat: stage every main push",
              pull: {
                number: 96,
                title: "feat: stage every main push",
                labels: labels[96],
              },
            },
          ],
          published: {
            "v1.26.0": at(-600),
            [EARLIER]: at(0),
            [OWN]: at(50),
            ...published,
          },
          ...rest,
        },
      },
    });

  const soakWith = (fake, minutes, overrides = {}) =>
    resolveWith(fake, {
      minimumAge: "1h",
      now: T0 + minutes * 60_000,
      ...overrides,
    });

  return {
    collectBuild,
    createDirectory,
    fixturePath,
    packages,
    publishWith,
    removeDirectory,
    resolveWith,
    soaking,
    soakWith,
    staged,
  };
};
