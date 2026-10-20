import { isSafeHref } from "@app/lib/utils/source_urls";
import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

const isElement = (target: EventTarget | null): target is Element =>
  target instanceof Element;

/** The link a Cmd or Ctrl primary click on an editable document opens, if any. */
const linkToOpen = (
  view: EditorView,
  event: MouseEvent
): HTMLAnchorElement | null => {
  if (!view.editable) {
    return null;
  }
  const isModifiedPrimaryClick =
    event.button === 0 && (event.metaKey || event.ctrlKey);
  if (!isModifiedPrimaryClick) {
    return null;
  }
  const link = isElement(event.target) ? event.target.closest("a") : null;
  // The attribute tells whether the link has an href at all; `href` is it resolved, as opened.
  if (!link?.getAttribute("href") || !view.dom.contains(link)) {
    return null;
  }
  return isSafeHref(link.href) ? link : null;
};

// The browser moves the caret on mousedown, and ProseMirror starts tracking the click there.
// Returning true skips ProseMirror's mousedown, so it never selects the clicked node on mouseup.
const keepSelection = (view: EditorView, event: MouseEvent) => {
  if (!linkToOpen(view, event)) {
    return false;
  }
  event.preventDefault();
  return true;
};

const openLink = (view: EditorView, event: MouseEvent) => {
  const link = linkToOpen(view, event);
  if (!link) {
    return false;
  }
  event.preventDefault();
  window.open(link.href, "_blank", "noopener,noreferrer");
  return true;
};

/**
 * @cc [owner:PopDaph,label:product;security] document-link-modified-click
 * In an editable document, a Cmd or Ctrl primary click on an http(s) or mailto link MUST open it
 * in a new tab, without the opener, and MUST NOT change the selection. Any other link or click
 * MUST be left to the editor and the browser.
 */
export const DocumentLinks = Extension.create({
  name: "documentLinks",
  addProseMirrorPlugins: () => [
    new Plugin({
      props: {
        handleDOMEvents: { mousedown: keepSelection, click: openLink },
      },
    }),
  ],
});
