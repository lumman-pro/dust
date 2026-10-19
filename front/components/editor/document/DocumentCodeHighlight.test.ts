import { buildDocumentEditorExtensions } from "@app/components/editor/document/editorExtensions";
import type { MessageDescriptor } from "@lingui/core";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

const translate = (descriptor: MessageDescriptor) => descriptor.id ?? "";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

const codeBlock = (language: string | null, text: string) => ({
  type: "doc",
  content: [
    {
      type: "codeBlock",
      attrs: { language },
      content: [{ type: "text", text }],
    },
  ],
});

const mount = (content: object) => {
  editor = new Editor({
    extensions: buildDocumentEditorExtensions(translate, {
      resolveImageSource: () => null,
    }),
    content,
  });
  return editor;
};

const coloredText = (editor: Editor, className: string) =>
  Array.from(
    editor.view.dom.querySelectorAll(`pre .${className}`),
    (span) => span.textContent
  );

describe("DocumentCodeHighlight", () => {
  it("colors the tokens of a code block in a known language", () => {
    const mounted = mount(codeBlock("ts", 'const a = "b";'));

    expect(coloredText(mounted, "text-violet-500")).toEqual(["const"]);
    expect(coloredText(mounted, "text-green-500")).toEqual(['"b"']);
  });

  it("leaves a code block without a known language plain", () => {
    for (const language of [null, "not-a-language"]) {
      const mounted = mount(codeBlock(language, "const a = 1;"));

      expect(mounted.view.dom.querySelectorAll("pre span")).toHaveLength(0);
      mounted.destroy();
    }
    editor = null;
  });

  it("recolors a code block as it is edited, without changing its text", () => {
    const mounted = mount(codeBlock("ts", "a"));
    mounted.commands.insertContentAt(1, "let ");

    expect(coloredText(mounted, "text-violet-500")).toEqual(["let"]);
    expect(mounted.state.doc.textContent).toBe("let a");
  });
});
