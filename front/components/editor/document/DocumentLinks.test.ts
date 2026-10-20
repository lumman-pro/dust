import { buildDocumentEditorExtensions } from "@app/components/editor/document/editorExtensions";
import type { MessageDescriptor } from "@lingui/core";
import { fireEvent } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const translate = (descriptor: MessageDescriptor) => descriptor.id ?? "";

let editor: Editor | null = null;

const renderLink = (href: string, { editable = true } = {}) => {
  editor = new Editor({
    element: document.body.appendChild(document.createElement("div")),
    extensions: buildDocumentEditorExtensions(translate, {
      resolveImageSource: () => null,
    }),
    content: `<p><a href="${href}">pricing</a></p>`,
    editable,
  });
  const link = editor.view.dom.querySelector("a");
  if (!link) {
    throw new Error("The link did not render.");
  }
  return link;
};

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("DocumentLinks", () => {
  it.each([
    ["Cmd", { metaKey: true }],
    ["Ctrl", { ctrlKey: true }],
  ])("opens a link in a new tab on %s+click", (_, modifier) => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const link = renderLink("https://dust.tt/pricing");

    fireEvent.click(link, modifier);

    expect(open).toHaveBeenCalledWith(
      "https://dust.tt/pricing",
      "_blank",
      "noopener,noreferrer"
    );
  });

  it("opens a mailto link on Cmd+click", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const link = renderLink("mailto:team@dust.tt");

    fireEvent.click(link, { metaKey: true });

    expect(open).toHaveBeenCalledWith(
      "mailto:team@dust.tt",
      "_blank",
      "noopener,noreferrer"
    );
  });

  it("does not open a link of another protocol", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const link = renderLink("ftp://files.dust.tt/report.pdf");

    fireEvent.click(link, { metaKey: true });

    expect(open).not.toHaveBeenCalled();
  });

  it("does not open a link on a plain click", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const link = renderLink("https://dust.tt/pricing");

    fireEvent.click(link);

    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    ["claims a Cmd+click", { metaKey: true }, true],
    ["leaves a plain click", {}, false],
  ])(
    "%s on a link before ProseMirror selects the clicked node",
    (_, modifier, claimed) => {
      const link = renderLink("https://dust.tt/pricing");
      const view = editor?.view;
      if (!view) {
        throw new Error("The editor did not mount.");
      }
      // jsdom has no layout, so ProseMirror's mousedown (posAtCoords) cannot run: call the prop.
      const mouseup = new MouseEvent("mouseup", { ...modifier, button: 0 });
      Object.defineProperty(mouseup, "target", { value: link });

      expect(
        view.someProp("handleClick", (handle) => handle(view, 1, mouseup)) ??
          false
      ).toBe(claimed);
    }
  );

  it("leaves a link in a read-only document to the browser", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const link = renderLink("https://dust.tt/pricing", { editable: false });

    // `fireEvent` returns false when a handler cancels the click.
    expect(fireEvent.click(link, { metaKey: true })).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });
});
