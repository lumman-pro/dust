import { LIST_ITEM_NODE_NAME } from "@app/components/editor/document/DocumentListItem";
import { isNumber, isString } from "@app/types/shared/utils/general";
import {
  Check,
  cn,
  Icon,
  taskStepBadgeCheckClassName,
  taskStepBadgeNumberClassName,
  taskStepBadgeVariants,
} from "@dust-tt/sparkle";
import type { Editor } from "@tiptap/core";
import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { DOMSerializer } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Decoration, NodeView } from "@tiptap/pm/view";
import { Decoration as NodeDecoration, DecorationSet } from "@tiptap/pm/view";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

const isNode = (target: EventTarget | null): target is Node =>
  target instanceof globalThis.Node;

/** The text of an item's first paragraph, images read as their alt text. */
const itemText = (item: ProseMirrorNode) => {
  const paragraph = item.firstChild;
  return paragraph
    ? paragraph
        .textBetween(0, paragraph.content.size, " ", (leaf) =>
          isString(leaf.attrs.alt) ? ` ${leaf.attrs.alt} ` : ""
        )
        .replace(/\s+/g, " ")
        .trim()
    : "";
};

/**
 * Sparkle's check icon, as its badge draws it, rendered once when this module loads: TipTap draws
 * node views while React mounts the editor, when React would not render another root at once.
 */
const CHECK_ICON = (() => {
  const container = document.createElement("span");
  const root = createRoot(container);
  flushSync(() =>
    root.render(
      createElement(Icon, {
        visual: Check,
        size: "2xs",
        className: taskStepBadgeCheckClassName,
      })
    )
  );
  const icon = container.firstChild;
  root.unmount();
  return icon;
})();

const checkIcon = () =>
  CHECK_ICON?.cloneNode(true) ?? document.createDocumentFragment();

const stepNumber = (decorations: readonly Decoration[]) =>
  decorations
    .map((decoration): unknown => decoration.spec.taskStep)
    .find(isNumber);

/** A node decoration on each task of a numbered list, its spec holding the task's number. */
const taskStepDecorations = (doc: ProseMirrorNode) => {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "orderedList") {
      const start = isNumber(node.attrs.start) ? node.attrs.start : 1;
      node.forEach((item, offset, index) => {
        if (item.attrs.task) {
          const from = pos + 1 + offset;
          decorations.push(
            NodeDecoration.node(
              from,
              from + item.nodeSize,
              {},
              { taskStep: start + index }
            )
          );
        }
      });
    }
    return !node.isTextblock;
  });
  return DecorationSet.create(doc, decorations);
};

/** The list item as its schema draws it, its content inside. */
const renderListItem = (node: ProseMirrorNode) =>
  DOMSerializer.renderSpec(document, node.type.spec.toDOM?.(node) ?? ["li", 0]);

const listItemView = ({
  node,
  getPos,
  decorations,
  editor,
  emptyTaskLabel,
}: {
  node: ProseMirrorNode;
  getPos: () => number | undefined;
  decorations: readonly Decoration[];
  editor: Editor;
  emptyTaskLabel: string;
}): NodeView => {
  const { dom, contentDOM: item } = renderListItem(node);
  if (!node.attrs.task || !item) {
    return {
      dom,
      contentDOM: item,
      update: (updated) => updated.type === node.type && !updated.attrs.task,
    };
  }

  item.classList.add("list-none");
  const column = document.createElement("span");
  column.contentEditable = "false";
  column.className = "float-left my-1 -ml-7 flex h-7 w-7 items-center";
  const badge = document.createElement("button");
  badge.type = "button";
  badge.setAttribute("role", "checkbox");
  column.append(badge);
  const content = document.createElement("div");
  content.className = "flow-root [&>p]:my-1 [&>ul]:my-1 [&>ol]:my-1";
  item.append(column, content);

  let current = node;
  let step = stepNumber(decorations);
  let shown: string | null = null;
  const render = () => {
    const checked = current.attrs.checked === true;
    badge.className = cn(
      taskStepBadgeVariants({ checked }),
      "mt-0 cursor-pointer ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-hidden",
      "in-[.ProseMirror[contenteditable=false]]:cursor-default"
    );
    badge.setAttribute("aria-checked", String(checked));
    badge.setAttribute("aria-label", itemText(current) || emptyTaskLabel);
    const next = checked ? "done" : step === undefined ? "" : String(step);
    if (next !== shown) {
      shown = next;
      if (checked) {
        badge.replaceChildren(checkIcon());
      } else if (step !== undefined) {
        const number = document.createElement("span");
        number.className = taskStepBadgeNumberClassName;
        number.textContent = String(step);
        badge.replaceChildren(number);
      } else {
        badge.replaceChildren();
      }
    }
  };
  render();

  badge.addEventListener("mousedown", (event) => event.preventDefault());
  badge.addEventListener("click", () => {
    const pos = getPos();
    if (!editor.isEditable || !isNumber(pos)) {
      return;
    }
    const checked = current.attrs.checked !== true;
    editor
      .chain()
      .focus(undefined, { scrollIntoView: false })
      .command(({ tr }) => {
        tr.setNodeAttribute(pos, "checked", checked);
        return true;
      })
      .run();
  });

  return {
    dom,
    contentDOM: content,
    update: (updated, updatedDecorations) => {
      if (updated.type !== node.type || !updated.attrs.task) {
        return false;
      }
      current = updated;
      step = stepNumber(updatedDecorations);
      render();
      return true;
    },
    stopEvent: (event) => isNode(event.target) && column.contains(event.target),
    ignoreMutation: (mutation) =>
      mutation.type !== "selection" && column.contains(mutation.target),
  };
};

/**
 * Draws each task of the editor as Sparkle's task step badge, which editors tick. The collab
 * server never draws a document, so this lives outside the schema it bundles.
 */
/**
 * @cc [owner:rfrenoy,label:product] document-task-step-number
 * An open task of a numbered list MUST show the number its item has in the Markdown, the
 * list's `start` plus the item's index, plain items counted, and MUST follow every change to
 * the list. A task of a bulleted list MUST show no number.
 */
/**
 * @cc [owner:rfrenoy,label:product] document-task-item-read-only
 * In an editor that is not editable, clicking or pressing Space on a task's checkbox MUST NOT
 * change the document nor the checkbox's state. In an editable one, it MUST toggle only that
 * item's `checked`.
 */
export const DocumentTaskBadges = Extension.create<{
  /** The name of a task's checkbox when its item has no text. */
  emptyTaskLabel: string;
}>({
  name: "documentTaskBadges",

  addOptions: () => ({ emptyTaskLabel: "Task" }),

  addProseMirrorPlugins() {
    const { editor } = this;
    const { emptyTaskLabel } = this.options;
    const key = new PluginKey<DecorationSet>("documentTaskSteps");
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, { doc }) => taskStepDecorations(doc),
          apply: (tr, steps) =>
            tr.docChanged ? taskStepDecorations(tr.doc) : steps,
        },
        props: {
          decorations: (state) => key.getState(state),
          nodeViews: {
            [LIST_ITEM_NODE_NAME]: (node, _view, getPos, decorations) =>
              listItemView({
                node,
                getPos,
                decorations,
                editor,
                emptyTaskLabel,
              }),
          },
        },
      }),
    ];
  },
});
