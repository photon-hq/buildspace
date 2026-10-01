export const INTERNAL_PREFIX = "@photon-hq/";

export async function fetchPackageMetadata(name) {
  if (!name.startsWith(INTERNAL_PREFIX)) {
    throw new Error(`Not an internal registry package: ${name}`);
  }
  if (!process.env.NODE_AUTH_TOKEN) {
    throw new Error("NODE_AUTH_TOKEN is required to read GitHub Packages");
  }
  const response = await fetch(
    `https://npm.pkg.github.com/${encodeURIComponent(name)}`,
    {
      headers: {
        authorization: `Bearer ${process.env.NODE_AUTH_TOKEN}`,
        accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!response.ok) {
    throw new Error(`${name}: registry returned HTTP ${response.status}`);
  }
  return response.json();
}
