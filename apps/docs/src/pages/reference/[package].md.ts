import type { APIRoute } from "astro";

import { generateReferenceMarkdown } from "../../lib/reference-docs";
import { referencePackages, type ReferencePackage } from "../../lib/reference-packages";
import { readPackageReadme } from "../../lib/reference-readme";

interface Props {
  pkg: ReferencePackage;
}

export function getStaticPaths() {
  return referencePackages.map((pkg) => ({
    params: { package: pkg.slug },
    props: { pkg },
  }));
}

export const GET = (async ({ props: { pkg } }) => {
  const readme = await readPackageReadme(pkg);
  return new Response(`${readme.trim()}\n\n${await generateReferenceMarkdown(pkg)}`, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}) satisfies APIRoute<Props>;
