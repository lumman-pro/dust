import { Extension } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { ElementContent, RootContent } from "hast";
import { common, createLowlight } from "lowlight";

const lowlight = createLowlight(common);

// The Markdown preview's token colors, spelled out as classes: its theme is inline styles the
// design system does not export. Tokens it leaves in the text color are left out.
const TOKEN_CLASSES: Record<string, string> = {
  "hljs-keyword": "text-violet-500",
  "hljs-operator": "text-violet-500",
  "hljs-function": "text-blue-600",
  "hljs-title": "text-blue-600",
  "hljs-method": "text-blue-600",
  "hljs-built_in": "text-golden-500",
  "hljs-literal": "text-golden-500",
  "hljs-number": "text-golden-500",
  "hljs-attr": "text-golden-500",
  "hljs-string": "text-green-500",
  "hljs-comment": "text-golden-700",
  "hljs-template-variable": "text-rose-500",
  "hljs-tag": "text-rose-500",
  "hljs-name": "text-rose-500",
  "hljs-emphasis": "italic",
  "hljs-strong": "font-bold",
};

/** A run of code text and the class of its innermost colored token, if any. */
type Run = { length: number; className: string | null };

const toRuns = (
  nodes: (RootContent | ElementContent)[],
  className: string | null = null
): Run[] =>
  nodes.flatMap((node) => {
    if (node.type === "text") {
      return [{ length: node.value.length, className }];
    }
    if (node.type !== "element") {
      return [];
    }
    const tokens = node.properties.className;
    const own = Array.isArray(tokens)
      ? tokens.map((token) => TOKEN_CLASSES[String(token)]).find(Boolean)
      : undefined;
    return toRuns(node.children, own ?? className);
  });

/** Runs of a code block, keyed by language and code, so unchanged blocks are not re-highlighted. */
type RunCache = Map<string, Run[]>;

const highlight = (doc: Node, previous: RunCache) => {
  const cache: RunCache = new Map();
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "codeBlock") {
      return true;
    }
    const language: string | null = node.attrs.language;
    if (!language || !lowlight.registered(language)) {
      return false;
    }
    const key = `${language}\n${node.textContent}`;
    const runs =
      previous.get(key) ??
      toRuns(lowlight.highlight(language, node.textContent).children);
    cache.set(key, runs);
    let from = pos + 1;
    for (const { length, className } of runs) {
      if (className) {
        decorations.push(
          Decoration.inline(from, from + length, { class: className })
        );
      }
      from += length;
    }
    return false;
  });
  return { decorations: DecorationSet.create(doc, decorations), cache };
};

const documentCodeHighlightKey = new PluginKey<ReturnType<typeof highlight>>(
  "documentCodeHighlight"
);

/**
 * @cc [owner:avervaet,label:product] document-code-highlight
 * A code block whose language the highlighter knows MUST show its tokens in the Markdown
 * preview's colors, as decorations only, so highlighting never changes the document or its save.
 */
export const DocumentCodeHighlight = Extension.create({
  name: "documentCodeHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: documentCodeHighlightKey,
        state: {
          init: (_, { doc }) => highlight(doc, new Map()),
          apply: (tr, state) =>
            tr.docChanged ? highlight(tr.doc, state.cache) : state,
        },
        props: {
          decorations: (state) =>
            documentCodeHighlightKey.getState(state)?.decorations,
        },
      }),
    ];
  },
});
