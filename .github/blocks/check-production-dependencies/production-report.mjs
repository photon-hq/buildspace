const markdown = (value) =>
  String(value).replaceAll(
    /[&<>|`*_[\]@\r\n\\]/g,
    (character) => `&#${character.codePointAt(0)};`
  );

const verdict = (production) => {
  if (production === true) {
    return "✅ Yes";
  }

  if (production === false) {
    return "❌ No";
  }

  return "❓ Unknown";
};

export const renderProductionReport = function renderProductionReport({
  source,
  packages,
  crates,
  errors,
}) {
  const tables = [];

  if (packages || !crates) {
    tables.push(
      "| Internal package | Version | Prod? | Reason |",
      "| --- | --- | --- | --- |",
      ...(packages ?? []).map(
        ({ name, version, production, reason }) =>
          `| ${markdown(name)} | ${markdown(version)} | ${verdict(production)} | ${markdown(reason)} |`
      ),
      "",
      ...(packages?.length ? [] : ["No package inventory is available.", ""]),
      "Prod means the exact version is stable, published, and not deprecated. Includes direct and transitive `@photon-hq/*` dependencies. Unknown means registry status could not be verified.",
      ""
    );
  }

  if (crates) {
    tables.push(
      "| Internal crate | Version | Source | Prod? | Reason |",
      "| --- | --- | --- | --- | --- |",
      ...crates.map(
        ({ name, version, repository, reference, production, reason }) =>
          `| ${markdown(name)} | ${markdown(version)} | ${markdown(`${repository} ${reference}`)} | ${verdict(production)} | ${markdown(reason)} |`
      ),
      "",
      ...(crates.length ? [] : ["Cargo.lock resolves no internal crates.", ""]),
      "Prod means Cargo.lock resolves the crate at an exact stable version from a `vX.Y.Z` release tag of its repository, and that tag is a published release at the resolved commit. Includes direct and transitive crates fetched from the owner's GitHub repositories. Unknown means the release could not be verified.",
      ""
    );
  }

  return [
    "## Production dependencies",
    "",
    `Source: ${markdown(source)}`,
    "",
    errors.length
      ? "**Production dependency check failed.**"
      : "**Production dependency check passed.**",
    "",
    ...tables,
    ...(errors.length
      ? [
          "### Findings",
          "",
          ...errors.map((error) => `- ${markdown(error)}`),
          "",
          "Review these findings against the current dependency policy.",
          "",
        ]
      : []),
  ].join("\n");
};
