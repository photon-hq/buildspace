export const GITHUB_PACKAGES = "https://npm.pkg.github.com";
export const NPMJS = "https://registry.npmjs.org";
const SCOPED_NAME = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const UNSCOPED_NAME = /^[a-z0-9][a-z0-9._-]{0,213}$/;
const SCOPE = /^@[a-z0-9][a-z0-9._-]*\/$/;

export const STABLE =
  /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)$/;

const PRODUCTION_TAG_PREFIX = /^(?:[a-z0-9][a-z0-9._-]*-)?v$/;
export const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies"];
export const SHA = /^[a-f0-9]{40}$/;
export const SUFFIX = /^-staging\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const LEVELS = new Set(["none", "patch", "minor", "major"]);

export const sortedNames = (values) => JSON.stringify([...values].toSorted());

/** A selection lists `@scope/` prefixes and exact package names. */
export const matchesPackage = (name, selection) =>
  typeof name === "string" &&
  selection.some((entry) =>
    entry.endsWith("/") ? name.startsWith(entry) : name === entry
  );

export const missingSelectedPackage = (selection, packages) =>
  selection.find((name) => !name.endsWith("/") && !packages.has(name));

/** Why a bump cannot name a build's version, if it cannot. */
export const bumpProblem = function bumpProblem(bump) {
  if (!STABLE.test(bump?.version ?? "")) {
    return `version ${bump?.version}`;
  }

  if (bump.from !== null && typeof bump.from !== "string") {
    return `from ${bump.from}`;
  }

  if (!LEVELS.has(bump.level)) {
    return `level ${bump.level}`;
  }

  if (
    !Number.isInteger(bump.total) ||
    !Array.isArray(bump.changes) ||
    !Array.isArray(bump.warnings)
  ) {
    return "changes";
  }
};

/** A package's internal dependencies are published before it. */
export const publishOrder = function publishOrder(manifests) {
  const order = [];
  const state = new Map();

  const visit = (name, path) => {
    if (state.get(name) === "done") {
      return;
    }

    if (state.get(name) === "visiting") {
      throw new Error(
        `Packages depend on each other: ${[...path, name].join(" -> ")}`
      );
    }

    state.set(name, "visiting");
    const manifest = manifests.get(name);

    for (const field of [...DEPENDENCY_FIELDS, "peerDependencies"]) {
      for (const dependency of Object.keys(manifest[field] ?? {}).toSorted()) {
        if (dependency !== name && manifests.has(dependency)) {
          visit(dependency, [...path, name]);
        }
      }
    }

    state.set(name, "done");
    order.push(name);
  };

  for (const name of [...manifests.keys()].toSorted()) {
    visit(name, []);
  }

  return order;
};

const isUnscoped = (name) =>
  typeof name === "string" &&
  UNSCOPED_NAME.test(name) &&
  !["node_modules", "favicon.ico"].includes(name);

const selectPackages = (packageInput, packageSelection, registryUrl, owner) => {
  const unscoped = isUnscoped(packageInput);

  if (registryUrl === NPMJS && !SCOPED_NAME.test(packageInput) && !unscoped) {
    throw new Error(
      "A package on npmjs is named by the package input, @scope/name or name"
    );
  }

  const listed = packageSelection.split(/\s+/).filter(Boolean);

  if (listed.length) {
    if (
      registryUrl !== NPMJS ||
      listed.some(
        (entry) =>
          !SCOPE.test(entry) && !SCOPED_NAME.test(entry) && !isUnscoped(entry)
      )
    ) {
      throw new Error(
        "The package selection lists the @scope/ prefixes and names of a build on npmjs"
      );
    }

    if (!matchesPackage(packageInput, listed)) {
      throw new Error(
        `The package selection must include the package input ${packageInput}`
      );
    }

    return listed;
  }

  if (registryUrl === NPMJS) {
    if (unscoped) {
      return [packageInput];
    }

    const [scope] = packageInput.split("/");

    return [`${scope}/`];
  }

  return [`@${owner}/`];
};

/**
 * A repository whose `vX.Y.Z` tags already name something else, such as the
 * releases of a service, gives its packages a production tag prefix of their
 * own: `<name>-v`. GitHub Packages holds the owner's scope; a public package
 * on npmjs names its own scope, or only itself when unscoped, unless the
 * package selection lists the build's exact names and scopes.
 */
export const releaseNames = function releaseNames({
  repository,
  packageInput = "",
  packageSelection = "",
  tagPrefix = "",
  productionTagPrefix = "",
  registryUrl = GITHUB_PACKAGES,
}) {
  const [owner, repo] = repository.split("/");

  if (productionTagPrefix && !PRODUCTION_TAG_PREFIX.test(productionTagPrefix)) {
    throw new Error(
      `Invalid production tag prefix ${productionTagPrefix}: use v or <name>-v`
    );
  }

  if (![GITHUB_PACKAGES, NPMJS].includes(registryUrl)) {
    throw new Error(
      `Unsupported registry ${registryUrl}: use ${GITHUB_PACKAGES} or ${NPMJS}`
    );
  }

  return {
    registryUrl,
    selection: selectPackages(
      packageInput,
      packageSelection,
      registryUrl,
      owner
    ),
    primary: packageInput || `@${owner}/${repo}`,
    tagPrefix: tagPrefix || `${repo}-staging-`,
    productionTagPrefix: productionTagPrefix || "v",
  };
};
