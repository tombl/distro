// Lightweight renderer for the reference documentation prose. `@deno/doc`
// hands back JSDoc bodies as plain strings, so the backtick code spans and
// inline `{@link ...}` tags would otherwise print verbatim. This turns just
// those constructs into HTML, nothing heavier.

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

// `{@link Target}` and `{@link Target label}`. The target is either a page
// anchor (a symbol or one of its members) or an absolute URL.
const LINK_TAG = /\{@link(?:\s+([^\s}|][^}|]*))?\}/g;

function renderLink(match: string, body: string | undefined, resolve: ResolveLink): string {
  if (!body) return escapeHtml(match);
  const [target, ...labelParts] = body.trim().split(/\s+/);
  const label = labelParts.length > 0 ? labelParts.join(" ") : undefined;
  const href = resolve(target);
  const text = escapeHtml(label ?? target);
  return href ? `<a href="${href}">${text}</a>` : text;
}

type ResolveLink = (target: string) => string | undefined;

// Renders one block of inline prose: escapes, then applies backtick code
// spans and `{@link}` tags. Everything else stays as authored text.
function renderInline(text: string, resolve: ResolveLink): string {
  const escaped = escapeHtml(text);
  const withLinks = escaped.replace(LINK_TAG, (match, body) => renderLink(match, body, resolve));
  return withLinks.replaceAll(/`([^`\n]+)`/g, (_, code) => `<code>${code}</code>`);
}

export interface DocBlock {
  kind: "code" | "text";
  language?: string;
  html?: string;
  code?: string;
}

export function renderDoc(doc: string, resolve: ResolveLink): DocBlock[] {
  const blocks: DocBlock[] = [];
  const fence = /```(\w*)\n([\s\S]*?)```/g;
  let cursor = 0;
  for (const match of doc.matchAll(fence)) {
    if (match.index! > cursor) {
      blocks.push({
        kind: "text",
        html: renderParagraphs(doc.slice(cursor, match.index), resolve),
      });
    }
    blocks.push({ kind: "code", code: match[2].trim(), language: match[1] || "ts" });
    cursor = match.index! + match[0].length;
  }
  if (cursor < doc.length) {
    blocks.push({ kind: "text", html: renderParagraphs(doc.slice(cursor), resolve) });
  }
  return blocks;
}

function renderParagraphs(text: string, resolve: ResolveLink): string {
  return text
    .split(/\n{2,}/)
    .filter((paragraph) => paragraph.trim() !== "")
    .map((paragraph) => {
      // Hard-wrapped prose: a single newline is a soft break, not a paragraph.
      const inline = paragraph.trim().replaceAll("\n", " ");
      return `<p>${renderInline(inline, resolve)}</p>`;
    })
    .join("");
}

export function renderInlineDoc(doc: string, resolve: ResolveLink): string {
  return renderInline(doc.trim(), resolve);
}
