import { getCollection } from "astro:content";

export function getPublishedDocs() {
  return getCollection("docs", ({ data }) => !data.draft);
}
