import { SUFFIX, bumpTo, fixturePath, pack } from "./package-release.mjs";

const NPMJS = "https://registry.npmjs.org";

const PUBLIC = {
  packageInput: "@photon-ai/otel",
  registryUrl: NPMJS,
  bump: bumpTo("3.9.0", "v3.8.2"),
};

const PUBLIC_STAGING = `3.9.0${SUFFIX}`;

const packPublic = () => {
  pack(fixturePath("staging"), {
    name: "@photon-ai/otel",
    version: PUBLIC_STAGING,
  });
  pack(fixturePath("production"), {
    name: "@photon-ai/otel",
    version: "3.9.0",
  });
};

export { NPMJS, PUBLIC, PUBLIC_STAGING, packPublic };
