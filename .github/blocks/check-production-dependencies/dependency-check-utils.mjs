import semver from "semver";
import { INTERNAL_PREFIX } from "./internal-packages.mjs";

export const FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

export const internal = (name) => name.startsWith(INTERNAL_PREFIX);

export const baseVersion = (version) => String(version ?? "").split("(")[0];

export const exactStable = (version) => {
  const parsed = typeof version === "string" ? semver.parse(version) : null;

  return (
    parsed !== null &&
    parsed.prerelease.length === 0 &&
    `${parsed.version}${parsed.build.length ? `+${parsed.build.join(".")}` : ""}` ===
      version
  );
};

export const stableRange = (range) =>
  typeof range === "string" &&
  semver.validRange(range) !== null &&
  new semver.Range(range).set
    .flat()
    .every(
      ({ operator, semver: bound }) =>
        !bound.prerelease?.length ||
        (operator === "<" && bound.prerelease.join(".") === "0")
    );
