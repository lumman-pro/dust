import type { Meta, StoryObj } from "@storybook/react";
import React from "react";

import {
  Button,
  ChevronSelectorVertical,
  Icon,
  OptionCard,
  XClose,
} from "../index_with_tw_base";

const meta = {
  title: "Product/Conversation/OptionCard",
  component: OptionCard,
  parameters: {
    docs: {
      description: {
        component: `A selectable card representing one choice the user can pick in response to an agent prompt. Shows a \`label\`, optional \`description\`, and an optional \`counterValue\` badge; \`selected\` toggles its active styling and \`disabled\` makes it non-interactive. Becomes clickable when an \`onClick\` handler is provided.

**When to use**
- To present a small set of mutually understandable options (e.g. which sources to include) that the user selects before the agent continues.

**Guidelines**
- Provide \`onClick\` to make the card interactive; without it the card is display-only.
- Use \`counterValue\` to convey ordering or quantity, and \`selected\` to reflect the current choice (it sets \`aria-pressed\`).
- Use \`selectionIndicator="radio"\` for single-select lists and \`selectionIndicator="checkbox"\` for multi-select lists, so the selection mode is visually unambiguous.
- Pass \`startActions\` or \`endActions\` for controls at the start or end of a display-only card, such as a drag handle or a remove button.
- Set \`type="input"\` for a free-text "type something else" option; OptionCard renders the field itself (pass \`value\`/\`onChange\`) and keeps the same chrome and counter.
- Stack multiple cards in a column; for one-tap suggested prompts that send immediately, use **QuickReplyBlock** instead.`,
      },
    },
  },
  tags: ["autodocs"],
} satisfies Meta<typeof OptionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Interactive single card — tweak label, description, counter, and state
 * flags from the Controls panel.
 * @summary Configurable card via Controls.
 */
export const Playground: Story = {
  args: {
    label: "Summarize today's emails",
    description:
      "Unread messages, key threads, and anything that needs a reply.",
    counterValue: 1,
    selected: false,
    disabled: false,
  },
};

/**
 * The default option card (`type="option"`, unselected): label, description,
 * and counter badge with resting styling.
 * @summary Default unselected option.
 */
export const Default: Story = {
  args: {
    label: "Unread emails",
    description: "Only conversations you have not opened yet.",
    counterValue: 1,
    selected: false,
  },
};

/**
 * The same option card with `selected` on, showing the active styling and
 * `aria-pressed` state that reflects the user's current choice.
 * @summary Selected option styling.
 */
export const Selected: Story = {
  args: {
    label: "Unread emails",
    description: "Only conversations you have not opened yet.",
    counterValue: 1,
    selected: true,
  },
};

/**
 * `type="input"`: a free-text "type something else" option. The card renders
 * the text field itself — pass `value` / `onChange` — while keeping the same
 * chrome and counter as sibling options.
 * @summary Free-text option with inline input field.
 */
export const WithInlineInput: StoryObj = {
  render: () => {
    const [custom, setCustom] = React.useState("");
    return (
      <div className="w-full max-w-sm">
        <OptionCard
          type="input"
          counterValue={3}
          placeholder="Type something else"
          value={custom}
          onChange={setCustom}
        />
      </div>
    );
  },
};

/**
 * Visual reference: selected, unselected, and input cards stacked the way
 * they appear in an agent question — each state is covered individually in
 * the stories above.
 * @summary Gallery of the three card states stacked.
 */
export const AllStates: StoryObj = {
  tags: ["!manifest"],
  render: () => {
    const [custom, setCustom] = React.useState("");
    return (
      <div className="flex w-full max-w-sm flex-col gap-2">
        <OptionCard
          label="Unread emails"
          description="Only conversations you have not opened yet."
          counterValue={1}
          selected
        />
        <OptionCard
          label="Slack mentions"
          description="Messages where you were directly tagged."
          counterValue={2}
        />
        <OptionCard
          type="input"
          counterValue={3}
          placeholder="Type something else"
          value={custom}
          onChange={setCustom}
        />
      </div>
    );
  },
};

/**
 * A disabled card next to an enabled one: `disabled` mutes the styling and
 * makes the card non-interactive, e.g. an option no longer applicable.
 * @summary Disabled card alongside an enabled one.
 */
export const DisabledOption: StoryObj = {
  render: () => (
    <div className="flex w-full max-w-sm flex-col gap-2">
      <OptionCard
        label="Slack mentions"
        description="Messages where you were directly tagged."
        counterValue={2}
        disabled
      />
      <OptionCard
        label="Calendar conflicts"
        description="Events that overlap with your focus blocks."
        counterValue={3}
      />
    </div>
  ),
};

/**
 * `selectionIndicator="radio"` on every card in the list signals a
 * single-select question — exactly one option can be active.
 * @summary Radio indicators for single-select lists.
 */
export const SingleSelect: StoryObj = {
  render: () => (
    <div className="flex w-full max-w-sm flex-col gap-2">
      <OptionCard
        label="Unread emails"
        description="Only conversations you have not opened yet."
        counterValue={1}
        selectionIndicator="radio"
        selected
      />
      <OptionCard
        label="Slack mentions"
        description="Messages where you were directly tagged."
        counterValue={2}
        selectionIndicator="radio"
      />
      <OptionCard
        label="Calendar conflicts"
        description="Events that overlap with your focus blocks."
        counterValue={3}
        selectionIndicator="radio"
      />
    </div>
  ),
};

/**
 * `selectionIndicator="checkbox"` signals a multi-select question — several
 * cards can be `selected` at once.
 * @summary Checkbox indicators for multi-select lists.
 */
export const MultiSelect: StoryObj = {
  render: () => (
    <div className="flex w-full max-w-sm flex-col gap-2">
      <OptionCard
        label="Unread emails"
        description="Only conversations you have not opened yet."
        counterValue={1}
        selectionIndicator="checkbox"
        selected
      />
      <OptionCard
        label="Slack mentions"
        description="Messages where you were directly tagged."
        counterValue={2}
        selectionIndicator="checkbox"
        selected
      />
      <OptionCard
        label="Calendar conflicts"
        description="Events that overlap with your focus blocks."
        counterValue={3}
        selectionIndicator="checkbox"
      />
    </div>
  ),
};

/**
 * `startActions` and `endActions` add controls at the start and end of a
 * display-only card, here a drag handle and a remove button on each item of a
 * ranking.
 * @summary Leading and trailing card actions.
 */
export const WithActions: StoryObj = {
  render: () => (
    <div className="flex w-full max-w-sm flex-col gap-2">
      {["Fix the login bug", "Ship the billing page"].map((label, index) => (
        <OptionCard
          key={label}
          label={label}
          counterValue={index + 1}
          startActions={
            <Icon
              visual={ChevronSelectorVertical}
              size="sm"
              className="text-faint"
            />
          }
          endActions={
            <Button
              icon={XClose}
              variant="ghost-secondary"
              size="xs"
              tooltip="Remove"
            />
          }
        />
      ))}
    </div>
  ),
};
