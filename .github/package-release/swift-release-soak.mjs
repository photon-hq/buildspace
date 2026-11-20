import { exec, notFound, tagCommit } from "./package-release.mjs";
import { STAGING_TAG } from "./swift-release-manifest.mjs";

const AGE = /^(?<amount>0|[1-9]\d*)(?<unit>[mhd])$/;
const AGE_LABEL = /^min-staging-age:(?<age>.+)$/;
const AGE_UNIT = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** A duration such as 30m, 2h or 1d, in milliseconds. */
export const parseAge = function parseAge(text) {
  const match = AGE.exec(String(text).trim());

  if (!match) {
    throw new Error(
      `Invalid minimum staging age "${text}". Use minutes, hours or days, for example 30m, 2h or 1d.`
    );
  }

  const { amount, unit } = match.groups;

  return Number(amount) * AGE_UNIT[unit];
};

/** A duration for people, in whole minutes rounded with `round`. */
export const formatAge = function formatAge(milliseconds, round = Math.floor) {
  const minutes = Math.max(0, round(milliseconds / 60_000));

  const parts = [
    [Math.floor(minutes / 1440), "d"],
    [Math.floor((minutes % 1440) / 60), "h"],
    [minutes % 60, "m"],
  ].filter(([count]) => count);

  return parts.length
    ? parts.map(([count, unit]) => `${count}${unit}`).join(" ")
    : "0m";
};

const changeName = ({ sha, pull, subject }) =>
  pull ? `#${pull.number} ${pull.title}` : `${sha.slice(0, 12)} ${subject}`;

const onStaging = (change) =>
  change.since === undefined ? "none" : formatAge(change.age);

const minimumOf = (change) =>
  `${formatAge(change.required)}${change.declared ? " (PR label)" : ""}`;

export const changeLine = (change) =>
  `${changeName(change)}: on staging ${onStaging(change)}, minimum ${minimumOf(change)}`;

const stagingTimes = ({ commits, run, repository, after, release }) => {
  const position = new Map(commits.map(({ sha }, index) => [sha, index]));
  // The earliest counted staging release built at each commit of the range.
  const firstAt = Array.from({ length: commits.length }, () => Infinity);

  for (const { ref, object } of JSON.parse(
    run("gh", ["api", `repos/${repository}/git/matching-refs/tags/v`])
  )) {
    const tag = ref.slice("refs/tags/".length);

    if (!STAGING_TAG.test(tag)) {
      continue;
    }

    const index = position.get(
      object.type === "commit" ? object.sha : tagCommit(run, repository, tag)
    );

    if (index === undefined) {
      continue;
    }

    const staged = release(tag);
    const published = Date.parse(staged?.published_at ?? "");

    if (!staged?.prerelease || staged.draft || !(published > after)) {
      continue;
    }

    firstAt[index] = Math.min(firstAt[index], published);
  }

  // A change rides in the builds at its own commit and every later one.
  const since = [];
  let earliest = Infinity;

  for (let index = commits.length - 1; index >= 0; index -= 1) {
    earliest = Math.min(earliest, firstAt[index]);
    since[index] = Number.isFinite(earliest) ? earliest : undefined;
  }

  return since;
};

/**
 * How long each change the build carries, since the latest release, has run
 * on staging. Staging Macs install the newest staging release and every later
 * build on main still carries a change, so a change's clock starts with the
 * first staging release that carries it. Publishing a release sends GitGate's
 * staging Macs back to it until the next main push, so only staging releases
 * published after the latest release count. Each change needs `minimum`, or
 * the longer age its pull request's min-staging-age:<age> label declares;
 * labels only ever lengthen the wait. The build waits for every change.
 */
export const stagingSoak = function stagingSoak({
  repository,
  sourceSha,
  latest,
  minimum,
  now = Date.now(),
  run = exec,
}) {
  const api = (route) => JSON.parse(run("gh", ["api", route]));

  const release = (tag) => {
    try {
      return api(`repos/${repository}/releases/tags/${tag}`);
    } catch (error) {
      if (notFound(error)) {
        return;
      }

      throw error;
    }
  };

  // With no release yet, the build's own commit is the only change.
  let commits = [api(`repos/${repository}/commits/${sourceSha}`)];
  let after = -Infinity;

  if (latest) {
    const base = tagCommit(run, repository, latest);

    if (!base) {
      throw new Error(`${latest} does not point to a commit.`);
    }

    // Without the release's publish time there is no telling which staging
    // builds came after it, so refuse rather than count them all.
    after = Date.parse(release(latest)?.published_at ?? "");

    if (!Number.isFinite(after)) {
      throw new TypeError(`${latest} has no published GitHub release.`);
    }

    commits = [];

    for (let page = 1; ; page += 1) {
      const { total_commits: total, commits: batch } = api(
        `repos/${repository}/compare/${base}...${sourceSha}?per_page=100&page=${page}`
      );

      commits.push(...batch);

      if (!batch.length || commits.length >= total) {
        break;
      }
    }
  }

  const since = stagingTimes({ commits, run, repository, after, release });

  const changes = commits.map(({ sha, commit }, index) => {
    let pulls;

    try {
      pulls = api(`repos/${repository}/commits/${sha}/pulls`);
    } catch (error) {
      // GitHub answers 403 both for a missing permission and for rate limiting; any other 403 is passed on as is.
      const stderr = String(error?.stderr ?? "");

      if (/Resource not accessible by integration/i.test(stderr)) {
        throw new Error(
          `GitHub refused access to the pull requests of ${repository}. Give the promote job pull-requests: read.`,
          { cause: error }
        );
      }

      if (/rate limit/i.test(stderr)) {
        throw new Error(
          `The GitHub API rate limit stopped access to the pull requests of ${repository}. Try again later.`,
          { cause: error }
        );
      }

      throw error;
    }

    // Only the pull request that merged the change into main declares its age.
    const pull =
      pulls.find(
        (candidate) => candidate.merged_at && candidate.base?.ref === "main"
      ) ?? null;

    let required = minimum;
    let declared = null;

    for (const { name } of pull?.labels ?? []) {
      const label = AGE_LABEL.exec(name);

      if (!label) {
        continue;
      }

      const age = parseAge(label.groups.age);

      if (age > required) {
        [required, declared] = [age, name];
      }
    }

    const age = since[index] === undefined ? 0 : now - since[index];

    return {
      sha,
      subject: (commit?.message ?? "").split("\n")[0],
      pull: pull && { number: pull.number, title: pull.title },
      required,
      declared,
      since: since[index],
      age,
      remaining: required - age,
    };
  });

  // A pull request merged with its own commits is one change: its last commit's wait.
  const byPull = new Map();

  for (const change of changes) {
    const key = change.pull ? `#${change.pull.number}` : change.sha;

    if (!byPull.has(key) || change.remaining > byPull.get(key).remaining) {
      byPull.set(key, change);
    }
  }

  const merged = [...byPull.values()];

  return {
    minimum,
    changes: merged,
    waiting: merged.filter(({ remaining }) => remaining > 0),
  };
};

/** The reviewer's section on time on staging: an optional note, then each change. */
export const soakSummary = function soakSummary(soak, note = "") {
  const lines = ["### Time on staging", ""];

  if (note) {
    lines.push(note, "");
  }

  if (soak) {
    const rows = soak.changes.map(
      (change) =>
        `| ${changeName(change).replaceAll("|", "\\|")} | ${onStaging(change)} | ${minimumOf(change)} |`
    );

    lines.push(
      "| Change | On staging | Minimum |",
      "| --- | --- | --- |",
      ...rows,
      ""
    );
  }

  return lines;
};
