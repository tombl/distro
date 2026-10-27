import type { APIRoute } from "astro";

import { getPublishedDocs } from "../lib/docs";
import { referenceSections } from "../lib/reference-packages";

export const GET: APIRoute = async ({ site }) => {
  const docs = await getPublishedDocs();
  const sectionOrder = ["chapters", "reference", "questions"];
  const links = docs
    .toSorted(
      (a, b) =>
        sectionOrder.indexOf(a.data.section) - sectionOrder.indexOf(b.data.section) ||
        a.data.order - b.data.order ||
        a.data.title.localeCompare(b.data.title),
    )
    .map((entry) => {
      const url = new URL(`/${entry.id}.md`, site);
      return `- [${entry.data.title}](${url}): ${entry.data.description}`;
    });
  const references = referenceSections.map((pkg) => {
    const url = new URL(`/reference/${pkg.slug}.md`, site);
    return `- [${pkg.name} reference](${url}): ${pkg.description}`;
  });
  const body = [
    "# Lowland documentation",
    "",
    "> Run and control WebAssembly Linux machines in browsers and Node.js.",
    "",
    "## Documentation",
    "",
    ...links,
    "",
    "## API reference",
    "",
    ...references,
    "",
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
