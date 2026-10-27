// Turns a code fence marked `run`, such as ```ts run, into a runnable
// <Example>. The fence stays an ordinary code block in the markdown source,
// which the .md pages serve verbatim.
export function runnableExamples() {
  return (tree: unknown, file: { path?: string }) => {
    if (!file.path?.endsWith(".mdx")) return;
    (function walk(node: any): void {
      const children: any[] = node?.children ?? [];
      for (const [index, child] of children.entries()) {
        if (child.type === "code" && /(^|\s)run(\s|$)/.test(child.meta ?? "")) {
          children[index] = {
            type: "mdxJsxFlowElement",
            name: "Example",
            attributes: [
              { type: "mdxJsxAttribute", name: "code", value: child.value },
              { type: "mdxJsxAttribute", name: "lang", value: child.lang ?? "ts" },
            ],
            children: [],
          };
        } else {
          walk(child);
        }
      }
    })(tree);
  };
}
