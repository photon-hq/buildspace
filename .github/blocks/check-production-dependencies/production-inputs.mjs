import { execFile } from "node:child_process";
import { access, glob, readFile } from "node:fs/promises";
import nodePath from "node:path";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";
import { parse, parseAllDocuments } from "yaml";

const exec = promisify(execFile);

export const readProductionInputs = async (root, ref) => {
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
    : (path) => readFile(nodePath.join(root, path), "utf-8");

  const tree = ref
    ? (await git("ls-tree", "-rz", "--name-only", source)).split("\0")
    : null;

  const exists = async (path) => {
    if (tree) {
      return tree.includes(path);
    }

    try {
      await access(nodePath.join(root, path));

      return true;
    } catch {
      return false;
    }
  };

  const inputs = { source };

  if (await exists("pnpm-workspace.yaml")) {
    Object.assign(inputs, await readPnpmInputs(root, read, tree));
  }

  if ((await exists("Cargo.toml")) || (await exists("Cargo.lock"))) {
    inputs.cargo = await readCargoInputs(root, read, tree);
  }

  if (!inputs.workspace && !inputs.cargo) {
    throw new Error(
      `${source} has neither a pnpm workspace nor a Cargo workspace to check`
    );
  }

  return inputs;
};

const readPnpmInputs = async (root, read, tree) => {
  const workspace = parse(await read("pnpm-workspace.yaml"));
  const patterns = workspace.packages ?? [];

  const included = (path) =>
    patterns.some(
      (pattern) =>
        !pattern.startsWith("!") && nodePath.matchesGlob(path, pattern)
    ) &&
    !patterns.some(
      (pattern) =>
        pattern.startsWith("!") && nodePath.matchesGlob(path, pattern.slice(1))
    );

  let paths;

  if (tree) {
    paths = tree.filter(
      (path) =>
        path.endsWith("/package.json") && included(nodePath.dirname(path))
    );
  } else {
    paths = [];

    for (const pattern of patterns.filter((entry) => !entry.startsWith("!"))) {
      for await (const path of glob(`${pattern}/package.json`, {
        cwd: root,
        exclude: ["**/node_modules/**", "**/.git/**"],
      })) {
        if (included(nodePath.dirname(path))) {
          paths.push(path);
        }
      }
    }
  }

  const manifests = Object.fromEntries(
    await Promise.all(
      [...new Set(["package.json", ...paths])].map(async (path) => [
        nodePath.dirname(path),
        JSON.parse(await read(path)),
      ])
    )
  );

  const documents = parseAllDocuments(await read("pnpm-lock.yaml"));

  for (const document of documents) {
    if (document.errors.length) {
      throw document.errors[0];
    }
  }

  const lockfiles = documents.map((document) => document.toJS());

  if (
    lockfiles.length < 1 ||
    lockfiles.length > 2 ||
    lockfiles.some(
      (lockfile) =>
        !lockfile || typeof lockfile !== "object" || Array.isArray(lockfile)
    )
  ) {
    throw new Error(
      "Expected one pnpm lockfile or a toolchain document followed by the application lockfile"
    );
  }

  if (lockfiles.length === 2) {
    const [toolchain] = lockfiles;
    const { importers } = toolchain;
    const importer = importers?.["."];
    const application = lockfiles[1].importers?.["."];

    if (
      !application ||
      Object.keys(application).some((field) =>
        ["configDependencies", "packageManagerDependencies"].includes(field)
      )
    ) {
      throw new Error(
        "The second pnpm lockfile document must contain application importers"
      );
    }

    if (
      !importer ||
      Object.keys(importers).length !== 1 ||
      !Object.keys(importer).length ||
      Object.keys(importer).some(
        (field) =>
          !["configDependencies", "packageManagerDependencies"].includes(field)
      )
    ) {
      throw new Error(
        "The first pnpm lockfile document must contain only toolchain importers"
      );
    }
  }

  return {
    workspace,
    manifests,
    lockfile: lockfiles.at(-1),
    toolchainLockfiles: lockfiles.slice(0, -1),
  };
};

const readCargoInputs = async (root, read, tree) => {
  const required = async (path) => {
    try {
      return parseToml(await read(path));
    } catch (error) {
      throw new Error(
        `A Cargo workspace needs a committed root ${path}: ${error.message}`,
        { cause: error }
      );
    }
  };

  const manifests = { ".": await required("Cargo.toml") };
  const lockfile = await required("Cargo.lock");

  const paths = tree
    ? tree.filter((path) => path.endsWith("/Cargo.toml"))
    : await Array.fromAsync(
        glob("**/Cargo.toml", {
          cwd: root,
          exclude: ["**/node_modules/**", "**/.git/**", "**/target/**"],
        })
      );

  for (const path of paths.filter((entry) => entry !== "Cargo.toml")) {
    try {
      manifests[nodePath.dirname(path)] = parseToml(await read(path));
    } catch {
      // Not a manifest Cargo could have built; a package Cargo.lock names
      // still needs a readable one.
    }
  }

  return { lockfile, manifests };
};
