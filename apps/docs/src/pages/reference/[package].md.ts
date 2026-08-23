import type { APIRoute } from "astro";

import { generateReferenceMarkdown } from "../../lib/reference-docs";
import { referencePackages, type ReferencePackage } from "../../lib/reference-packages";

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
  return new Response(await generateReferenceMarkdown(pkg), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}) satisfies APIRoute<Props>;
