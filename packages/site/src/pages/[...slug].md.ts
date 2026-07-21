import type { APIRoute } from "astro";
import { loadRenderers } from "astro:container";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import type { CollectionEntry } from "astro:content";
import { render } from "astro:content";
import { getContainerRenderer } from "@astrojs/mdx/container-renderer";
import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";

import MarkdownCodeBlock from "../components/MarkdownCodeBlock.astro";
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

const renderers = await loadRenderers([getContainerRenderer()]);
const container = await AstroContainer.create({ renderers });

export const GET = (async ({ props: { entry }, request }) => {
  const { Content } = await render(entry);
  const content = await container.renderToString(Content, {
    props: { components: { pre: MarkdownCodeBlock } },
  });
  const { document } = parseHTML(`<main>${content}</main>`);
  const pageUrl = new URL(`/${entry.id}/`, request.url).href;
  const result = await Defuddle(document, pageUrl, {
    contentSelector: "main",
    markdown: true,
  });
  const markdown = `# ${entry.data.title}\n\n${result.content.trim()}\n`;

  return new Response(markdown, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}) satisfies APIRoute<Props>;
