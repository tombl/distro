import type { APIRoute } from "astro";
import type { CollectionEntry } from "astro:content";

import { getPublishedDocs } from "../lib/docs";

interface Props {
  entry: CollectionEntry<"docs">;
}

export async function getStaticPaths() {
  const docs = await getPublishedDocs();
  return docs.map((entry) => ({
    params: { slug: entry.id },
    props: { entry },
  }));
}

export const GET = (({ props: { entry } }) => {
  return new Response(`${entry.body?.trim() ?? ""}\n`, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}) satisfies APIRoute<Props>;
