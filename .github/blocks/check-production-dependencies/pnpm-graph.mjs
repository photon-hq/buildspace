import nodePath from "node:path";
import semver from "semver";
import {
  FIELDS,
  baseVersion,
  exactStable,
  internal,
  stableRange,
} from "./dependency-check-utils.mjs";

const createGraphContext = ({ workspace, manifests, lockfile, toolchain }) => {
  const errors = new Set();
  const versions = new Map();
  const localPackages = new Map();

  for (const [path, manifest] of Object.entries(manifests)) {
    if (localPackages.has(manifest.name)) {
      errors.add(`Duplicate workspace package: ${manifest.name}`);
    }

    localPackages.set(manifest.name, path);
  }

  const localLink = (name, version, from) =>
    typeof version === "string" &&
    version.startsWith("link:") &&
    localPackages.get(name) ===
      nodePath.normalize(nodePath.join(from, version.slice(5)));

  const add = (name, version) => {
    if (!versions.has(name)) {
      versions.set(name, new Set());
    }

    versions.get(name).add(String(version ?? "missing"));

    if (!exactStable(version)) {
      errors.add(
        `${name}@${version}: must be pinned to an exact stable production version`
      );
    }
  };

  const catalogs = { default: workspace.catalog ?? {}, ...workspace.catalogs };

  const pin = (name, value) => {
    const version =
      typeof value === "string" && value.startsWith("catalog:")
        ? catalogs[value.slice(8) || "default"]?.[name]
        : value;

    add(name, version);

    return version;
  };

  const rejectAlias = (name, value) => {
    const text = String(value);

    if (!internal(name) && /^(?:npm:)?@photon-hq\//.test(text)) {
      const target =
        /^(?:npm:)?(?<name>@photon-hq\/[^@()/\s]+)(?:@(?<version>.+))?$/.exec(
          text
        );

      if (target) {
        add(target.groups.name, baseVersion(target.groups.version || "latest"));
      }

      errors.add(
        `${name}: internal package aliases are not supported; use the @photon-hq package name`
      );
    }
  };

  const resolved = (name, value) => {
    rejectAlias(name, value);

    if (!internal(name)) {
      return;
    }

    const version = baseVersion(value);
    add(name, version);

    if (
      !lockfile.packages?.[`${name}@${version}`] ||
      !lockfile.snapshots?.[`${name}@${value}`]
    ) {
      errors.add(
        `${name}@${value}: missing lockfile package or snapshot record`
      );
    }
  };

  return {
    workspace,
    manifests,
    lockfile,
    toolchain,
    errors,
    versions,
    catalogs,
    localLink,
    add,
    pin,
    rejectAlias,
    resolved,
  };
};

const inspectLockfileShape = ({ lockfile, errors }) => {
  if (
    String(lockfile.lockfileVersion) !== "9.0" ||
    !lockfile.importers ||
    !lockfile.packages ||
    !lockfile.snapshots
  ) {
    errors.add(
      "Expected a complete pnpm v9 lockfile (importers, packages, and snapshots)"
    );
  }
};

const inspectCatalogs = ({ lockfile, catalogs, errors, add, rejectAlias }) => {
  for (const catalog of Object.values(catalogs)) {
    for (const [name, version] of Object.entries(catalog)) {
      rejectAlias(name, version);

      if (internal(name)) {
        add(name, version);
      }
    }
  }

  for (const [catalogName, catalog] of Object.entries(
    lockfile.catalogs ?? {}
  )) {
    for (const [name, entry] of Object.entries(catalog)) {
      rejectAlias(name, entry.version);

      if (!internal(name)) {
        continue;
      }

      add(name, baseVersion(entry.version));

      if (
        entry.specifier !== catalogs[catalogName]?.[name] ||
        baseVersion(entry.version) !== catalogs[catalogName]?.[name]
      ) {
        errors.add(
          `${name}: lockfile catalog ${catalogName} does not match the declared pin`
        );
      }
    }
  }
};

const inspectToolchain = ({
  workspace,
  lockfile,
  errors,
  pin,
  rejectAlias,
}) => {
  for (const [name, value] of Object.entries(
    workspace.configDependencies ?? {}
  )) {
    rejectAlias(name, value);

    if (!internal(name)) {
      continue;
    }

    const version = pin(name, value);
    const entry = lockfile.importers?.["."]?.configDependencies?.[name];

    if (
      !entry ||
      entry.specifier !== value ||
      baseVersion(entry.version) !== version
    ) {
      errors.add(
        `${name}: toolchain config dependency does not match its workspace declaration`
      );
    }
  }
};

const manifestEntry = (field, importer, name) =>
  field === "peerDependencies"
    ? (importer?.dependencies?.[name] ??
      importer?.devDependencies?.[name] ??
      importer?.optionalDependencies?.[name])
    : importer?.[field]?.[name];

const isWorkspaceLink = (value, entry, name, path, localLink) =>
  typeof value === "string" &&
  value.startsWith("workspace:") &&
  entry?.specifier === value &&
  localLink(name, entry.version, path);

const inspectPeerRange = ({ field, value, entry, path, name, errors }) => {
  if (field !== "peerDependencies" || !stableRange(value)) {
    return false;
  }

  if (!entry || !semver.satisfies(baseVersion(entry.version), value)) {
    errors.add(
      `${path}: ${name} lockfile importer ${entry?.version ?? "missing"} does not satisfy the peer range ${value}`
    );
  }

  return true;
};

const importerMismatch = (entry, version, value) =>
  !entry || baseVersion(entry.version) !== version || entry.specifier !== value;

const inspectManifestDependency = ({
  lockfile,
  path,
  field,
  name,
  value,
  errors,
  localLink,
  pin,
  rejectAlias,
}) => {
  rejectAlias(name, value);

  if (!internal(name)) {
    return;
  }

  const importer = lockfile.importers?.[path];
  const entry = manifestEntry(field, importer, name);

  if (isWorkspaceLink(value, entry, name, path, localLink)) {
    return;
  }

  if (inspectPeerRange({ field, value, entry, path, name, errors })) {
    return;
  }

  const version = pin(name, value);

  if (importerMismatch(entry, version, value)) {
    errors.add(
      `${path}: ${name} lockfile importer does not match ${value} (${version})`
    );
  }

  if (typeof value === "string" && value.startsWith("catalog:")) {
    const catalogName = value.slice(8) || "default";

    if (!lockfile.catalogs?.[catalogName]?.[name]) {
      errors.add(`${name}: missing lockfile catalog ${catalogName}`);
    }
  }
};

const inspectManifestDependencies = (context) => {
  const { lockfile, manifests, errors, localLink, pin, rejectAlias } = context;

  for (const [path, manifest] of Object.entries(manifests)) {
    for (const field of FIELDS) {
      for (const [name, value] of Object.entries(manifest[field] ?? {})) {
        inspectManifestDependency({
          lockfile,
          path,
          field,
          name,
          value,
          errors,
          localLink,
          pin,
          rejectAlias,
        });
      }
    }
  }
};

const inspectImporters = (context) => {
  const { lockfile, manifests, toolchain, errors, localLink, pin, resolved } =
    context;

  const fields = toolchain
    ? ["configDependencies", "packageManagerDependencies"]
    : FIELDS;

  for (const [path, importer] of Object.entries(lockfile.importers ?? {})) {
    for (const field of fields) {
      for (const [name, entry] of Object.entries(importer[field] ?? {})) {
        if (toolchain && internal(name)) {
          pin(name, entry.specifier);
        }

        if (!localLink(name, entry.version, path)) {
          resolved(name, entry.version);
        }

        if (
          !toolchain &&
          internal(name) &&
          !FIELDS.some((key) => manifests[path]?.[key]?.[name])
        ) {
          errors.add(
            `${path}: ${name} lockfile importer has no manifest declaration`
          );
        }
      }
    }
  }
};

const inspectLockfileEntries = (context) => {
  const { lockfile, localLink, add, resolved, errors } = context;

  for (const section of ["packages", "snapshots"]) {
    for (const [key, entry] of Object.entries(lockfile[section] ?? {})) {
      for (const match of key.matchAll(
        /(?<name>@photon-hq\/[^@()/\s]+)@(?<version>[^()]+)/g
      )) {
        const { name, version } = match.groups;

        if (localLink(name, version, ".")) {
          continue;
        }

        add(name, version);

        if (!lockfile.packages?.[`${name}@${version}`]) {
          errors.add(`${name}@${version}: missing lockfile package record`);
        }
      }

      if (section === "snapshots") {
        for (const field of ["dependencies", "optionalDependencies"]) {
          for (const [name, value] of Object.entries(entry[field] ?? {})) {
            if (!localLink(name, value, ".")) {
              resolved(name, value);
            }
          }
        }
      }
    }
  }
};

export const inspectPnpmGraph = ({
  workspace,
  manifests,
  lockfile,
  toolchain = false,
}) => {
  const context = createGraphContext({
    workspace,
    manifests,
    lockfile,
    toolchain,
  });

  inspectLockfileShape(context);
  inspectCatalogs(context);

  if (toolchain) {
    inspectToolchain(context);
  }

  inspectManifestDependencies(context);
  inspectImporters(context);
  inspectLockfileEntries(context);

  return {
    errors: [...context.errors].toSorted(),
    versions: context.versions,
  };
};

export const inspectProductionDependencies =
  function inspectProductionDependencies(inputs) {
    const result = inspectPnpmGraph(inputs);
    let toolchains = inputs.toolchainLockfiles;

    if (!toolchains?.length && inputs.workspace.configDependencies) {
      toolchains = [
        {
          lockfileVersion: "9.0",
          importers: {},
          packages: {},
          snapshots: {},
        },
      ];
    }

    for (const lockfile of toolchains ?? []) {
      const audit = inspectPnpmGraph({
        workspace: inputs.workspace,
        manifests: {},
        lockfile,
        toolchain: true,
      });

      result.errors.push(...audit.errors);

      for (const [name, versions] of audit.versions) {
        if (!result.versions.has(name)) {
          result.versions.set(name, new Set());
        }

        for (const version of versions) {
          result.versions.get(name).add(version);
        }
      }
    }

    result.errors = [...new Set(result.errors)].toSorted();

    return result;
  };
