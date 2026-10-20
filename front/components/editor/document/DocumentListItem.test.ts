import {
  caretAfter,
  destroyOpenedEditors,
  markdown,
  openEditor,
  press,
  saved,
  type,
} from "@app/components/editor/document/editor.test_utils";
import { afterEach, describe, expect, it } from "vitest";

afterEach(destroyOpenedEditors);

describe("task items", () => {
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
});
