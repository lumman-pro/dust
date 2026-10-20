import { Mark } from "@tiptap/core";

export const AdditionMark = Mark.create({
  name: "addition",

  addAttributes() {
    return {
      timestamp: {
        default: () => Date.now(),
      },
    };
  },

  parseHTML() {
    return [{ tag: "ins.addition" }];
  },

  renderHTML() {
    return [
      "ins",
      {
        class:
          "addition no-underline text-success-700 bg-success-100 dark:text-green-100 dark:bg-green-800",
      },
      0,
    ];
  },
});

export const DeletionMark = Mark.create({
  name: "deletion",

  addAttributes() {
    return {
      timestamp: {
        default: () => Date.now(),
      },
    };
  },

  parseHTML() {
    return [{ tag: "del.deletion" }];
  },

  renderHTML() {
    return [
      "del",
      {
        class:
          "deletion text-warning-600 bg-warning-100 line-through dark:text-rose-100 dark:bg-rose-800",
      },
      0,
    ];
  },
});
