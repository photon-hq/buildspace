import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parse as parseToml } from "smol-toml";
import { STABLE } from "./package-release-policy.mjs";

export const CRATE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export const fileName = (name, version) =>
  `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;

export const crateFile = (name, version) => `${name}-${version}.crate`;

export const sha256 = (buffer) =>
  createHash("sha256").update(buffer).digest("hex");

export const integrity = (buffer) =>
  `sha512-${createHash("sha512").update(buffer).digest("base64")}`;

export const readTarballManifest = function readTarballManifest(path) {
  return JSON.parse(
    execFileSync("tar", ["-xOzf", path, "package/package.json"], {
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
    })
  );
};

/** The regular files of a gzipped tar archive, such as a `.crate`, by path. */
export const readArchive = function readArchive(path) {
  const archive = gunzipSync(readFileSync(path));
  const files = new Map();
  let longName;

  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);

    if (header.every((byte) => byte === 0)) {
      break;
    }

    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString("utf-8")
        .replace(/\0.*$/s, "");

    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = String.fromCodePoint(header[156]);
    const body = archive.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === "L") {
      longName = body.toString("utf-8").replace(/\0.*$/s, "");
      continue;
    }

    const prefix =
      header.subarray(257, 263).toString("latin1") === "ustar\0"
        ? field(345, 155)
        : "";

    const name =
      longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));

    longName = undefined;

    if (type === "5") {
      continue;
    }

    if (type !== "0" && type !== "\0") {
      throw new Error(`${path}: ${name} is not a regular file`);
    }

    if (files.has(name)) {
      throw new Error(`${path} holds ${name} more than once`);
    }

    files.set(name, body);
  }

  return files;
};

/**
 * What a `.crate` says about itself: the normalized manifest's name and
 * version, the commit `cargo package` recorded, and a digest of every file but
 * that record, so an unchanged crate from another commit compares equal.
 */
export const readCrate = function readCrate(path) {
  const files = readArchive(path);
  const roots = new Set([...files.keys()].map((name) => name.split("/")[0]));

  if (roots.size !== 1) {
    throw new Error(`${path} is not a crate`);
  }

  const [root] = roots;
  const text = (name) => files.get(`${root}/${name}`)?.toString("utf-8");
  const manifest = parseToml(text("Cargo.toml") ?? "");
  const vcs = JSON.parse(text(".cargo_vcs_info.json") ?? "{}");
  const digest = createHash("sha256");

  for (const name of [...files.keys()].toSorted()) {
    if (name !== `${root}/.cargo_vcs_info.json`) {
      digest.update(`${name}\0${sha256(files.get(name))}\n`);
    }
  }

  return {
    root,
    name: manifest.package?.name,
    version: manifest.package?.version,
    sourceSha: vcs.git?.sha1,
    dirty: vcs.git?.dirty === true,
    path: vcs.path_in_vcs,
    original: text("Cargo.toml.orig") ?? "",
    digest: digest.digest("hex"),
  };
};

/** Why a crate cannot describe this build, if it cannot. */
export const crateProblem = (crate, sourceSha) => {
  if (typeof crate.name !== "string" || !CRATE_NAME.test(crate.name)) {
    return `invalid crate name ${crate.name}`;
  }

  if (!STABLE.test(crate.version ?? "")) {
    return `${crate.name} ${crate.version}: a production candidate must be X.Y.Z`;
  }

  if (crate.root !== `${crate.name}-${crate.version}`) {
    return `${crate.name} is packaged under ${crate.root}`;
  }

  if (crate.sourceSha !== sourceSha || crate.dirty) {
    return `${crate.name} was packaged from ${crate.sourceSha ?? "an unknown commit"}${crate.dirty ? " with uncommitted changes" : ""}, not ${sourceSha}`;
  }
};
