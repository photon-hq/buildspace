import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

const errorCommit = "e".repeat(40);

const serve = (responses) => {
  const requested = [];
  globalThis.fetch = (url, options) => {
    requested.push(url);
    assert.equal(options.headers.authorization, "Bearer token");
    assert.equal(options.redirect, "manual");
    const [status, body = ""] = responses[url] ?? [500];

    return new Response(body, { status });
  };

  return requested;
};

export const registerInternalCrateReleaseCases = () => {
  test("release lookups tell an unreleased tag from a repository the token cannot read", async (t) => {
    const { fetchCrateRelease, internalRepository } =
      await import("./internal-crates.mjs");

    for (const [git, expected] of [
      ["https://github.com/photon-hq/error", "photon-hq/error"],
      ["https://github.com/Photon-HQ/Error.git", "photon-hq/error"],
      ["ssh://git@github.com/photon-hq/error.git", "photon-hq/error"],
      ["https://github.com/someone/error", null],
      ["https://example.com/photon-hq/error", null],
      ["not a url", null],
      [undefined, null],
    ]) {
      assert.equal(internalRepository(git), expected);
    }

    const realFetch = globalThis.fetch;
    const realToken = process.env.CRATES_TOKEN;
    t.after(() => {
      globalThis.fetch = realFetch;

      if (realToken === undefined) {
        delete process.env.CRATES_TOKEN;
      } else {
        process.env.CRATES_TOKEN = realToken;
      }
    });
    const base = "https://api.github.com/repos/photon-hq/error";

    delete process.env.CRATES_TOKEN;
    await assert.rejects(
      fetchCrateRelease("photon-hq/error", "v0.3.0"),
      /CRATES_TOKEN is required/
    );
    process.env.CRATES_TOKEN = "token";
    await assert.rejects(
      fetchCrateRelease("photon-hq/error", "main"),
      /Not an internal crate release/
    );
    await assert.rejects(
      fetchCrateRelease("photon-hq/a/b", "v0.3.0"),
      /Not an internal crate release/
    );

    const requested = serve({
      [`${base}/releases/tags/v0.3.0`]: [
        200,
        JSON.stringify({ draft: false, prerelease: false }),
      ],
      [`${base}/commits/refs/tags/v0.3.0`]: [200, `${errorCommit}\n`],
    });

    assert.deepEqual(await fetchCrateRelease("photon-hq/error", "v0.3.0"), {
      draft: false,
      prerelease: false,
      commit: errorCommit,
    });
    assert.equal(requested.length, 2);

    serve({
      [`${base}/releases/tags/v0.3.0`]: [404],
      [base]: [200, JSON.stringify({})],
    });
    assert.equal(await fetchCrateRelease("photon-hq/error", "v0.3.0"), null);
    serve({ [`${base}/releases/tags/v0.3.0`]: [404], [base]: [404] });
    await assert.rejects(
      fetchCrateRelease("photon-hq/error", "v0.3.0"),
      /repository returned HTTP 404; the token must be able to read/
    );
    serve({ [`${base}/releases/tags/v0.3.0`]: [301] });
    await assert.rejects(
      fetchCrateRelease("photon-hq/error", "v0.3.0"),
      /release v0.3.0 returned HTTP 301/
    );
    serve({
      [`${base}/releases/tags/v0.3.0`]: [
        200,
        JSON.stringify({ draft: false, prerelease: false }),
      ],
    });
    await assert.rejects(
      fetchCrateRelease("photon-hq/error", "v0.3.0"),
      /tag v0.3.0 returned HTTP 500/
    );
  });

  test("the action reads crate releases with crates-token, falling back to the calling repository's token", async () => {
    const action = parse(
      await readFile(new URL("action.yaml", import.meta.url), "utf-8")
    );

    assert.equal(action.inputs["crates-token"].default, "");
    assert.equal(
      action.runs.steps.at(-1).env.CRATES_TOKEN,
      ["$", "{{ inputs.crates-token || inputs.github-token }}"].join("")
    );
  });
};
