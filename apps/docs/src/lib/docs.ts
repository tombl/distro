import { getCollection } from "astro:content";

import { referencePackages } from "./reference-packages";

export function getPublishedDocs() {
  return getCollection("docs", ({ data }) => !data.draft);
}

export interface DocsItem {
  id: string;
  href: string;
  label: string;
  description: string;
  code?: boolean;
}

export async function getDocsSections(): Promise<{ heading: string; items: DocsItem[] }[]> {
  const docs = await getPublishedDocs();

  function section(name: (typeof docs)[number]["data"]["section"]): DocsItem[] {
    return docs
      .filter((doc) => doc.data.section === name)
      .sort((left, right) => left.data.order - right.data.order)
      .map((doc) => ({
        id: doc.id,
        href: `/${doc.id}/`,
        label: doc.data.title,
        description: doc.data.description,
      }));
  }

  return [
    { heading: "Tutorials", items: section("tutorials") },
    { heading: "How-to guides", items: section("howtos") },
    {
      heading: "Reference",
      items: [
        ...referencePackages.map((pkg) => ({
          id: `reference:${pkg.slug}`,
          href: `/reference/${pkg.slug}/`,
          label: pkg.name,
          description: pkg.description,
          code: true,
        })),
        ...section("reference"),
      ],
    },
    { heading: "Explanation", items: section("explanation") },
  ].filter(({ items }) => items.length > 0);
}
