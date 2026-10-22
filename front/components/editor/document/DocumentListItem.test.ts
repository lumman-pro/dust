import {
  caretAfter,
  destroyOpenedEditors,
  markdown,
  openEditor,
  paste,
  press,
  saved,
  stubClipboardEvent,
  stubRangeLayout,
  type,
} from "@app/components/editor/document/editor.test_utils";
import { Check } from "@dust-tt/sparkle";
import type { Editor } from "@tiptap/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(destroyOpenedEditors);

const checkboxes = (built: Editor) =>
  Array.from(built.view.dom.querySelectorAll<HTMLElement>('[role="checkbox"]'));

const isChecked = (checkbox: Element | undefined) =>
  checkbox?.getAttribute("aria-checked") === "true";

/** What each task's badge shows: its number, `✓` when done, or nothing. */
const badges = (built: Editor) =>
  checkboxes(built).map((checkbox) =>
    isChecked(checkbox) ? "✓" : (checkbox.textContent ?? "")
  );

describe("task items", () => {
  stubRangeLayout();

  it("nests a task after a plain item with Tab, and lifts it back with Shift-Tab", () => {
    const built = openEditor("- plain\n- [ ] task\n- [x] done\n");
    caretAfter(built, "task");

    press(built, "Tab");
    expect(markdown(built)).toBe("- plain\n  - [ ] task\n- [x] done");

    press(built, "Tab", { shiftKey: true });
    expect(markdown(built)).toBe("- plain\n- [ ] task\n- [x] done");
  });

  it("starts an unticked task on Enter after a ticked one, and leaves the list on an empty one", () => {
    const built = openEditor("- [x] done\n- after\n");
    caretAfter(built, "done");

    press(built, "Enter");
    type(built, "next");
    expect(markdown(built)).toBe("- [x] done\n- [ ] next\n- after");

    press(built, "Enter");
    press(built, "Enter");
    const { $from } = built.state.selection;
    expect([$from.depth, $from.parent.type.name]).toEqual([1, "paragraph"]);
    expect(markdown(built)).toMatch(/^- \[x\] done\n- \[ \] next\n\n+- after$/);
  });

  it("saves a new empty task, written as an empty item until it has text", () => {
    const built = openEditor("- [x] done\n");
    caretAfter(built, "done");

    press(built, "Enter");
    expect(saved(built)).toBe("- [x] done\n- &nbsp;\n");

    type(built, "next");
    expect(saved(built)).toBe("- [x] done\n- [ ] next\n");
  });

  it("converts an item from a selection in its second paragraph", () => {
    const built = openEditor("- First\n\n  Second\n- Other\n");
    caretAfter(built, "Second");

    expect(built.commands.toggleTaskList()).toBe(true);

    expect(saved(built)).toBe("- [ ] First\n\n  Second\n- Other\n");
  });

  it("converts only the nested item a selection is in, not its parent", () => {
    const built = openEditor("- Parent\n  - Child\n");
    caretAfter(built, "Child");

    built.commands.toggleTaskList();

    expect(saved(built)).toBe("- Parent\n  - [ ] Child\n");
  });

  it("keeps a ticked task ticked when a selection with a plain item becomes tasks", () => {
    const built = openEditor("- [x] done\n- plain\n");
    let from = 0;
    built.state.doc.descendants((node, pos) => {
      if (from === 0 && node.isText && node.text === "done") {
        from = pos;
      }
    });
    caretAfter(built, "plain");
    built.commands.setTextSelection({ from, to: built.state.selection.to });

    built.commands.toggleTaskList();

    expect(saved(built)).toBe("- [x] done\n- [ ] plain\n");
  });

  it("converts only the selected item of a list, and back", () => {
    const built = openEditor("1. a\n2. b\n3. c\n");
    caretAfter(built, "b");

    built.commands.toggleTaskList();
    expect(markdown(built)).toBe("1. a\n2. [ ] b\n3. c");

    built.commands.toggleTaskList();
    expect(markdown(built)).toBe("1. a\n2. b\n3. c");
  });

  it("makes every item of a fully selected list a task, keeping the list", () => {
    const built = openEditor("- a\n- b\n");

    built.commands.selectAll();

    expect(built.commands.toggleTaskList()).toBe(true);
    expect(saved(built)).toBe("- [ ] a\n- [ ] b\n");
  });

  it("makes a heading a task list", () => {
    const built = openEditor("# Groceries\n");
    caretAfter(built, "Groceries");

    expect(built.commands.toggleTaskList()).toBe(true);
    expect(saved(built)).toBe("- [ ] Groceries\n");
  });

  it("makes a paragraph a task list", () => {
    const built = openEditor("Buy milk\n");
    caretAfter(built, "Buy milk");

    built.commands.toggleTaskList();

    expect(markdown(built)).toBe("- [ ] Buy milk");
  });

  it.each([
    ["a paragraph", "a\n", "1. [ ] a\n"],
    [
      "a ticked bulleted task, numbering its list and keeping the tick",
      "- [x] a\n- b\n",
      "1. [x] a\n2. b\n",
    ],
    ["a numbered task, making it a plain item", "1. [ ] a\n", "1. a\n"],
  ])("toggles a numbered task on %s", (_, opened, result) => {
    const built = openEditor(opened);
    caretAfter(built, "a");

    expect(built.commands.toggleNumberedTaskList()).toBe(true);
    expect(saved(built)).toBe(result);
  });

  it.each([
    ["[ ] ", "- [ ] Milk"],
    ["[x] ", "- [x] Milk"],
    ["[] ", "- [ ] Milk"],
  ])(
    "makes a list item a task when %j is typed at its start",
    (marker, result) => {
      const built = openEditor("- x\n");
      built.commands.setContent({
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [{ type: "listItem", content: [{ type: "paragraph" }] }],
          },
        ],
      });
      built.commands.setTextSelection(3);

      type(built, `${marker}Milk`);

      expect(markdown(built)).toBe(result);
    }
  );

  it("ticks a task on click, keeping focus in the text so the keyboard undoes it", async () => {
    const built = openEditor("- [ ] Milk\n- Notes\n");
    const [checkbox] = checkboxes(built);
    const mousedown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });

    checkbox.dispatchEvent(mousedown);
    checkbox.click();
    expect(mousedown.defaultPrevented).toBe(true);
    expect(markdown(built)).toBe("- [x] Milk\n- Notes");
    expect(isChecked(checkboxes(built)[0])).toBe(true);

    await vi.waitFor(() => expect(document.activeElement).toBe(built.view.dom));
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "z",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
    );
    expect(markdown(built)).toBe("- [ ] Milk\n- Notes");
  });

  it("leaves the document and the checkbox unchanged when clicked read-only", () => {
    const built = openEditor("- [ ] Milk\n", { editable: false });
    const before = built.getJSON();
    const [checkbox] = checkboxes(built);

    checkbox.click();

    expect(built.getJSON()).toEqual(before);
    expect(isChecked(checkbox)).toBe(false);
  });

  it("labels a checkbox with its item's text", () => {
    const built = openEditor("- [x] Milk\n");

    expect(checkboxes(built)[0].getAttribute("aria-label")).toBe("Milk");
  });

  it("names the checkbox of an empty task", () => {
    const built = openEditor("- [x] done\n");
    caretAfter(built, "done");

    press(built, "Enter");

    expect(checkboxes(built)[1].getAttribute("aria-label")).toBe("Task");
  });

  it.each([
    ["a bulleted task list", "- [ ] a\n- [x] b\n- c\n", ["", "✓"]],
    [
      "a numbered list mixing tasks and plain items",
      "1. [ ] a\n2. b\n3. [x] c\n4. [ ] d\n",
      ["1", "✓", "4"],
    ],
    ["a numbered list starting at 0", "0. [ ] zero\n1. [ ] one\n", ["0", "1"]],
    [
      "a numbered task list nested in a bulleted one",
      "- [ ] parent\n  1. [ ] child\n",
      ["", "1"],
    ],
  ])("numbers the badges of %s by their place in it", (_, source, shown) => {
    expect(badges(openEditor(source))).toEqual(shown);
  });

  it("keeps a plain item's number next to tasks' badges", () => {
    const built = openEditor("1. [ ] a\n2. b\n");
    const [task, plain] = Array.from(built.view.dom.querySelectorAll("li"));

    expect(task.classList.contains("list-none")).toBe(true);
    expect(plain.classList.contains("list-none")).toBe(false);
    expect(plain.querySelector('[role="checkbox"]')).toBeNull();
  });

  it("renumbers the badges when an item is added above them", () => {
    const built = openEditor("1. a\n2. [ ] b\n");
    caretAfter(built, "a");

    press(built, "Enter");
    type(built, "new");

    expect(badges(built)).toEqual(["3"]);
  });

  it("draws Sparkle's check icon in a done task's badge", () => {
    const built = openEditor("- [x] done\n");
    const sparkle = new DOMParser()
      .parseFromString(
        renderToStaticMarkup(createElement(Check)),
        "image/svg+xml"
      )
      .querySelector("path");

    expect(
      checkboxes(built)[0].querySelector("svg path")?.getAttribute("d")
    ).toBe(sparkle?.getAttribute("d"));
  });

  it("renders a plain list without checkboxes", () => {
    const built = openEditor("- a\n- b\n\n1. c\n");

    expect(checkboxes(built)).toEqual([]);
    expect(built.view.dom.querySelectorAll("li > p")).toHaveLength(3);
  });
});

describe("pasted task lists", () => {
  stubClipboardEvent();

  it("keeps the tasks of a list copied from the editor", () => {
    const built = openEditor("Intro\n");
    caretAfter(built, "Intro");
    press(built, "Enter");

    paste(built, {
      "text/html":
        '<ul><li data-task="true" data-checked="true"><p>done</p></li><li data-task="true"><p>open</p></li></ul>',
    });

    expect(markdown(built)).toBe("Intro\n\n- [x] done\n- [ ] open");
  });
});
