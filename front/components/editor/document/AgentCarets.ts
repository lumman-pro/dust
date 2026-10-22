import type { TextRange } from "@app/components/editor/document/AgentEdits";
import { insertedTextRanges } from "@app/components/editor/document/AgentEdits";
import {
  changeMapping,
  isSessionChange,
  mapRanges,
  TYPING_SETTLE_MS,
  typedBands,
  typedLength,
} from "@app/components/editor/document/typedText";
import { onAgentActivity, onAgentEdit } from "@app/lib/client/collab/agents";
import { caretColor } from "@app/lib/client/collab/messages";
import datadogLogger from "@app/logger/datadogLogger";
import type { CollabAgent, DocumentActivity } from "@app/types/collab";
import { isDocumentActivity } from "@app/types/collab";
import { normalizeError } from "@app/types/shared/utils/error_utils";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { Extension } from "@tiptap/core";
import type { Fragment, Node } from "@tiptap/pm/model";
import { DOMSerializer } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ProsemirrorBinding, ySyncPluginKey } from "@tiptap/y-tiptap";

const ACTIVITY_SHOWN_MS: Record<DocumentActivity, number> = {
  reading: 20_000,
  editing: 3_100,
};
const LEAVING_MS = 400;
const ERASE_STEPS = 40;
const ERASE_STEP_MS = 25;
const ERASE_PAUSE_MS = 300;
const TYPING_SCROLL_MS = 450;
const TYPING_LEAD_MS = 650;
const TYPING_WORD_MAX_MS = 70;
const TYPING_MAX_MS = 2_400;
const TYPING_MAX_STEPS = Math.floor(TYPING_MAX_MS / TYPING_WORD_MAX_MS);
const MAX_TYPED_RANGES = 200;
const IN_VIEW_MARGIN_PX = 40;

export const AGENT_EDIT_SHOWN_MS =
  TYPING_SCROLL_MS +
  TYPING_LEAD_MS +
  ERASE_STEPS * ERASE_STEP_MS +
  ERASE_PAUSE_MS +
  TYPING_MAX_MS +
  TYPING_SETTLE_MS +
  ACTIVITY_SHOWN_MS.editing;

interface Typing {
  ranges: TextRange[];
  revealed: number;
  settled: boolean;
  removed: RemovedText[];
  erased: number;
}

export interface RemovedText {
  at: number;
  content: Fragment;
}

interface AgentCaret {
  agent: CollabAgent;
  position: number;
  typing: Typing | null;
  presence: "shown" | "leaving" | "gone";
}

const agentColor = (agent: CollabAgent, userId: string) =>
  agent.userId === userId
    ? "var(--color-highlight)"
    : caretColor(agent.agentId);

type AgentCarets = ReadonlyMap<string, AgentCaret>;

type AgentCaretsMeta =
  | { type: "activity"; agent: CollabAgent }
  | {
      type: "edited";
      agent: CollabAgent;
      ranges: TextRange[];
      typing: boolean;
      removed?: RemovedText[];
    }
  | {
      type: "typed";
      caretKey: string;
      typed: Partial<Pick<Typing, "revealed" | "erased" | "settled">>;
    }
  | { type: "end"; caretKey: string; presence?: "leaving" | "gone" };

export const agentCaretKey = ({ agentId, userId }: CollabAgent): string =>
  JSON.stringify([agentId, userId]);

const agentCaretsKey = new PluginKey<AgentCarets>("agentCarets");

export const withAgentCarets = (
  state: EditorState,
  meta: AgentCaretsMeta
): Transaction => state.tr.setMeta(agentCaretsKey, meta);

const agentCaretsOf = (state: EditorState): AgentCarets =>
  agentCaretsKey.getState(state) ?? new Map();

const applyAgentCarets = (
  transaction: Transaction,
  carets: AgentCarets,
  oldState: EditorState,
  newState: EditorState
): AgentCarets => {
  const meta: AgentCaretsMeta | undefined = transaction.getMeta(agentCaretsKey);
  if (!meta && !transaction.docChanged) {
    return carets;
  }
  const mapping = changeMapping(transaction, oldState, newState);
  const next = new Map(
    [...carets].map(([caretKey, caret]) => [
      caretKey,
      {
        ...caret,
        position: mapping.map(caret.position, -1),
        typing: caret.typing && {
          ...caret.typing,
          ranges: mapRanges(caret.typing.ranges, mapping),
          removed: caret.typing.removed.map((text) => ({
            ...text,
            at: mapping.map(text.at, -1),
          })),
        },
      },
    ])
  );
  switch (meta?.type) {
    case "activity": {
      const current = next.get(agentCaretKey(meta.agent));
      if (current) {
        next.set(agentCaretKey(meta.agent), {
          ...current,
          agent: meta.agent,
          presence: "shown",
        });
      }
      break;
    }
    case "edited":
      next.set(agentCaretKey(meta.agent), {
        agent: meta.agent,
        position: Math.max(...meta.ranges.map(({ to }) => to)),
        typing: meta.typing
          ? {
              ranges: meta.ranges,
              revealed: 0,
              settled: false,
              removed: meta.removed ?? [],
              erased: 0,
            }
          : null,
        presence: "shown",
      });
      break;
    case "typed": {
      const current = next.get(meta.caretKey);
      if (current?.typing) {
        next.set(meta.caretKey, {
          ...current,
          typing: { ...current.typing, ...meta.typed },
        });
      }
      break;
    }
    case "end": {
      const current = next.get(meta.caretKey);
      if (current) {
        next.set(meta.caretKey, {
          ...current,
          typing: null,
          presence: meta.presence ?? current.presence,
        });
      }
      break;
    }
  }
  return next;
};

const removedLength = (removed: RemovedText[]) =>
  removed.reduce((length, { content }) => length + content.size, 0);

const removedWidget = (doc: Node, content: Fragment) => {
  const text = document.createElement("span");
  text.append(
    DOMSerializer.fromSchema(doc.type.schema).serializeFragment(content)
  );
  return text;
};

const removedDecorations = (
  doc: Node,
  caretKey: string,
  removed: RemovedText[],
  erased: number
): { decorations: Decoration[]; erasingAt: number | null } => {
  const decorations: Decoration[] = [];
  let erasingAt: number | null = null;
  let offset = 0;
  for (const [index, { at, content }] of removed.entries()) {
    const kept =
      content.size - Math.min(Math.max(erased - offset, 0), content.size);
    offset += content.size;
    if (kept === 0) {
      continue;
    }
    erasingAt ??= at;
    const shown = content.cut(0, kept);
    decorations.push(
      Decoration.widget(at, () => removedWidget(doc, shown), {
        key: `${caretKey}:removed:${index}:${kept}`,
        side: -1,
      })
    );
  }
  return { decorations, erasingAt };
};

const wordEnds = (doc: Node, ranges: TextRange[]): number[] => {
  const ends: number[] = [];
  let offset = 0;
  for (const { from, to } of ranges) {
    for (const word of doc.textBetween(from, to).matchAll(/\S+\s*/g)) {
      ends.push(offset + word.index + word[0].length);
    }
    offset += to - from;
    if (ends.at(-1) !== offset) {
      ends.push(offset);
    }
  }
  return ends;
};

const typingSteps = (ends: number[]): number[] =>
  ends.length <= TYPING_MAX_STEPS
    ? ends
    : Array.from(
        { length: TYPING_MAX_STEPS },
        (_, index) =>
          ends[Math.ceil(((index + 1) * ends.length) / TYPING_MAX_STEPS) - 1]
      );

const caretWidget = ({ agent, presence }: AgentCaret, color: string) => {
  const caret = document.createElement("span");
  caret.classList.add("collaboration-carets__caret");
  if (presence === "leaving") {
    caret.classList.add("collab-caret-leaving");
  }
  caret.style.borderColor = color;
  const label = document.createElement("div");
  label.classList.add("collaboration-carets__label");
  label.style.backgroundColor = color;
  label.textContent = agent.userName
    ? `${agent.name} · ${agent.userName}`
    : agent.name;
  caret.append(label);
  return caret;
};

const caretDecorations = (
  doc: Node,
  caret: AgentCaret,
  color: string
): Decoration[] => {
  const hidden: Decoration[] = [];
  const removed = removedDecorations(
    doc,
    agentCaretKey(caret.agent),
    caret.typing?.removed ?? [],
    caret.typing?.erased ?? 0
  );
  let position = caret.position;
  let revealedEnd: number | null = null;
  let left = caret.typing?.revealed ?? 0;
  for (const { from, to } of caret.typing?.ranges ?? []) {
    const shown = Math.min(left, to - from);
    left -= shown;
    if (from + shown === to) {
      revealedEnd = to;
    } else {
      if (hidden.length === 0) {
        position = shown > 0 ? from + shown : (revealedEnd ?? from);
      }
      hidden.push(
        Decoration.inline(
          from + shown,
          to,
          { style: "display: none" },
          { agentCaret: "typing" }
        )
      );
    }
  }
  return [
    ...removed.decorations,
    ...hidden,
    ...(caret.typing
      ? typedBands(
          doc,
          color,
          caret.typing.ranges,
          caret.typing.revealed,
          caret.typing.settled
        )
      : []),
    Decoration.widget(
      Math.min(removed.erasingAt ?? position, doc.content.size),
      () => caretWidget(caret, color),
      {
        key: `${agentCaretKey(caret.agent)}:${caret.agent.name}:${caret.agent.userName}:${color}:${caret.presence}`,
        side: 10,
      }
    ),
  ];
};

/**
 * @cc [owner:adrien,label:product] live-agent-carets
 * An agent's edit that inserted text (`insertedTextRanges`) MUST show a caret at the end of that
 * text, labelled with the agent's name and the name of the user it works for (`userName`), one per
 * agent and user. The caret and the text it types MUST be in the highlight color when the agent
 * works for `userId`, in the agent's color otherwise. A later activity of the agent for that user
 * MUST show the caret again where it last was, and none MUST show before an edit in this editor.
 * Carets and the text being typed MUST follow later changes of the document and MUST only add
 * decorations, never change the document, the selection or undo history. An agent MUST disappear
 * its `ACTIVITY_SHOWN_MS` time after a read, or after an edit's typing ends, whatever it announces
 * meanwhile besides reading and editing: the caret fades out
 * (`collab-caret-leaving`) and is gone `LEAVING_MS` later.
 */
/**
 * @cc [owner:adrien,label:product] live-agent-typing
 * Unless the user prefers reduced motion or it spans more than `MAX_TYPED_RANGES` ranges, an edit's
 * inserted text MUST be hidden, and the text it removed (`removedText`) shown where it was, the
 * first block the edit changed scrolled into view when out of it and the agent works for `userId`,
 * never otherwise (then `TYPING_SCROLL_MS` more).
 * After `TYPING_LEAD_MS`, the removed text MUST be erased from its end in at most `ERASE_STEPS`
 * steps of `ERASE_STEP_MS`, the caret where it is being erased, then after `ERASE_PAUSE_MS` the
 * inserted text revealed in document order, in whole words, in at most `TYPING_MAX_STEPS` steps of
 * `TYPING_WORD_MAX_MS` or less so the whole takes at most `TYPING_MAX_MS`, the caret at the end of
 * what is revealed, at the end of the last revealed range until the next one starts. Within each text block, what is revealed MUST be banded in the
 * agent's color at its end (`collab-typed`), settling to the text color once a later block starts,
 * and all of it once the last word is shown; the band MUST go `TYPING_SETTLE_MS` later. A later edit
 * of the agent MUST reveal the rest at once.
 */
export const agentCaretsPlugin = (userId: string) =>
  new Plugin<AgentCarets>({
    key: agentCaretsKey,
    state: {
      init: () => new Map(),
      apply: applyAgentCarets,
    },
    props: {
      decorations: (state) =>
        DecorationSet.create(
          state.doc,
          [...agentCaretsOf(state).values()]
            .filter(({ presence }) => presence !== "gone")
            .flatMap((caret) =>
              caretDecorations(
                state.doc,
                caret,
                agentColor(caret.agent, userId)
              )
            )
        ),
    },
  });

interface RemoteChange {
  before: Node;
  after: Node;
}

const remoteChangeKey = new PluginKey<RemoteChange | null>("agentRemoteChange");

const remoteChangePlugin = () =>
  new Plugin<RemoteChange | null>({
    key: remoteChangeKey,
    state: {
      init: () => null,
      apply: (transaction, change, oldState, newState) => {
        if (!transaction.docChanged) {
          return change;
        }
        return isSessionChange(transaction)
          ? { before: oldState.doc, after: newState.doc }
          : null;
      },
    },
  });

interface TextBlock {
  node: Node;
  start: number;
}

const textBlocks = (doc: Node): TextBlock[] => {
  const blocks: TextBlock[] = [];
  doc.descendants((node, position) => {
    if (node.isTextblock) {
      blocks.push({ node, start: position + 1 });
      return false;
    }
    return true;
  });
  return blocks;
};

const blockText = ({ node, start }: TextBlock, doc: Node) =>
  doc.textBetween(start, start + node.content.size, "", "\n");

const sharedEnds = (a: string, b: string) => {
  const max = Math.min(a.length, b.length);
  let start = 0;
  while (start < max && a[start] === b[start]) {
    start++;
  }
  let end = 0;
  while (end < max - start && a[a.length - 1 - end] === b[b.length - 1 - end]) {
    end++;
  }
  return { start, end };
};

const countEqual = (
  before: TextBlock[],
  after: TextBlock[],
  at: (blocks: TextBlock[], index: number) => TextBlock,
  limit: number
) => {
  let count = 0;
  while (count < limit && at(before, count).node.eq(at(after, count).node)) {
    count++;
  }
  return count;
};

/**
 * @cc [owner:adrien,label:product] agent-removed-text
 * When `change` is the document's last change and came from the session, the text removed from
 * each text block holding `ranges` (in document order) MUST be found by pairing that block with the
 * block it replaced, once the text blocks equal before and after are set aside on both ends: in
 * order when as many
 * blocks changed as were there, otherwise only the first pair, and only if they share some text at
 * their start or end. The removed text is what the old block has beyond the start and end it shares
 * with the new one, placed where they meet. It MUST find none otherwise.
 */
export function removedText(
  change: RemoteChange | null,
  doc: Node,
  ranges: TextRange[]
): RemovedText[] {
  if (!change || change.after !== doc) {
    return [];
  }
  const before = textBlocks(change.before);
  const after = textBlocks(doc);
  const head = countEqual(
    before,
    after,
    (blocks, index) => blocks[index],
    Math.min(before.length, after.length)
  );
  const tail = countEqual(
    before,
    after,
    (blocks, index) => blocks[blocks.length - 1 - index],
    Math.min(before.length, after.length) - head
  );
  const old = before.slice(head, before.length - tail);
  const changed = after.slice(head, after.length - tail);
  const inOrder = old.length === changed.length;
  const pairs = inOrder
    ? changed.length
    : Math.min(1, old.length, changed.length);
  const removed: RemovedText[] = [];
  let next = 0;
  for (let index = 0; index < pairs; index++) {
    const oldBlock = old[index];
    const newBlock = changed[index];
    const newEnd = newBlock.start + newBlock.node.content.size;
    while (next < ranges.length && ranges[next].from < newBlock.start) {
      next++;
    }
    if (next === ranges.length || ranges[next].to > newEnd) {
      continue;
    }
    const oldText = blockText(oldBlock, change.before);
    const shared = sharedEnds(oldText, blockText(newBlock, doc));
    const removedEnd = oldText.length - shared.end;
    if (
      (inOrder || shared.start + shared.end > 0) &&
      removedEnd > shared.start
    ) {
      removed.push({
        at: newBlock.start + shared.start,
        content: oldBlock.node.content.cut(shared.start, removedEnd),
      });
    }
  }
  return removed;
}

const prefersReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const scrollArea = (element: HTMLElement): HTMLElement | null => {
  for (
    let parent = element.parentElement;
    parent;
    parent = parent.parentElement
  ) {
    if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) {
      return parent;
    }
  }
  return null;
};

const scrollToBlock = (view: EditorView, position: number): boolean => {
  const block = view.nodeDOM(view.state.doc.resolve(position).before());
  const area = block instanceof HTMLElement ? scrollArea(block) : null;
  if (!(block instanceof HTMLElement) || !area) {
    return false;
  }
  const box = block.getBoundingClientRect();
  const bounds = area.getBoundingClientRect();
  if (
    box.top > bounds.top + IN_VIEW_MARGIN_PX &&
    box.bottom < bounds.bottom - IN_VIEW_MARGIN_PX
  ) {
    return false;
  }
  block.scrollIntoView({ block: "center", behavior: "smooth" });
  return true;
};

export const agentCarets = (provider: HocuspocusProvider, userId: string) =>
  Extension.create<Record<string, never>, { unsubscribe: (() => void) | null }>(
    {
      name: "agentCarets",
      addStorage: () => ({ unsubscribe: null }),
      onCreate() {
        const timers = new Map<string, ReturnType<typeof setTimeout>>();
        const playbacks = new Map<string, ReturnType<typeof setTimeout>[]>();
        const dispatch = (meta: AgentCaretsMeta) => {
          if (!this.editor.isDestroyed) {
            this.editor.view.dispatch(withAgentCarets(this.editor.state, meta));
          }
        };
        const leaveAfter = (caretKey: string, delayMs: number) => {
          clearTimeout(timers.get(caretKey));
          timers.set(
            caretKey,
            setTimeout(() => {
              dispatch({ type: "end", caretKey, presence: "leaving" });
              timers.set(
                caretKey,
                setTimeout(() => {
                  timers.delete(caretKey);
                  dispatch({ type: "end", caretKey, presence: "gone" });
                }, LEAVING_MS)
              );
            }, delayMs)
          );
        };
        const stopTyping = (caretKey: string) => {
          playbacks.get(caretKey)?.forEach(clearTimeout);
          playbacks.delete(caretKey);
        };
        const type = (
          agent: CollabAgent,
          ranges: TextRange[],
          removed: RemovedText[]
        ): number => {
          const caretKey = agentCaretKey(agent);
          const ends = typingSteps(wordEnds(this.editor.state.doc, ranges));
          const stepMs = Math.min(
            TYPING_WORD_MAX_MS,
            TYPING_MAX_MS / ends.length
          );
          const firstAt = Math.min(
            ranges[0].from,
            ...removed.map(({ at }) => at)
          );
          const eraseMs =
            (agent.userId === userId && scrollToBlock(this.editor.view, firstAt)
              ? TYPING_SCROLL_MS
              : 0) + TYPING_LEAD_MS;
          const toErase = removedLength(removed);
          const erases = Math.min(ERASE_STEPS, toErase);
          const startMs =
            eraseMs +
            (erases > 0 ? erases * ERASE_STEP_MS + ERASE_PAUSE_MS : 0);
          const settleMs = startMs + ends.length * stepMs;
          playbacks.set(caretKey, [
            ...Array.from({ length: erases }, (_, index) =>
              setTimeout(
                () =>
                  dispatch({
                    type: "typed",
                    caretKey,
                    typed: {
                      erased: Math.round((toErase * (index + 1)) / erases),
                    },
                  }),
                eraseMs + index * ERASE_STEP_MS
              )
            ),
            ...ends.map((revealed, index) =>
              setTimeout(
                () =>
                  dispatch({ type: "typed", caretKey, typed: { revealed } }),
                startMs + index * stepMs
              )
            ),
            setTimeout(
              () =>
                dispatch({
                  type: "typed",
                  caretKey,
                  typed: {
                    revealed: typedLength(ranges),
                    erased: toErase,
                    settled: true,
                  },
                }),
              settleMs
            ),
            setTimeout(() => {
              playbacks.delete(caretKey);
              dispatch({ type: "end", caretKey });
            }, settleMs + TYPING_SETTLE_MS),
          ]);
          return settleMs + TYPING_SETTLE_MS;
        };
        const stopActivity = onAgentActivity(
          provider,
          ({ agent, activity }) => {
            if (
              !isDocumentActivity(activity) ||
              !agentCaretsOf(this.editor.state).has(agentCaretKey(agent))
            ) {
              return;
            }
            leaveAfter(agentCaretKey(agent), ACTIVITY_SHOWN_MS[activity]);
            dispatch({ type: "activity", agent });
          }
        );
        const stopEdit = onAgentEdit(provider, ({ agent, inserted }) => {
          if (this.editor.isDestroyed) {
            return;
          }
          let ranges: TextRange[] = [];
          let removed: RemovedText[] = [];
          let typing = false;
          try {
            const binding = ySyncPluginKey.getState(this.editor.state)?.binding;
            ranges =
              binding instanceof ProsemirrorBinding
                ? insertedTextRanges(binding, inserted)
                : [];
            typing =
              !prefersReducedMotion() && ranges.length <= MAX_TYPED_RANGES;
            removed =
              typing && ranges.length > 0
                ? removedText(
                    remoteChangeKey.getState(this.editor.state) ?? null,
                    this.editor.state.doc,
                    ranges
                  )
                : [];
          } catch (err) {
            datadogLogger.warn(
              { error: normalizeError(err).message },
              "Could not read an agent's edit"
            );
          }
          const caretKey = agentCaretKey(agent);
          stopTyping(caretKey);
          if (ranges.length === 0) {
            dispatch({ type: "end", caretKey });
            return;
          }
          const typingMs = typing ? type(agent, ranges, removed) : 0;
          dispatch({ type: "edited", agent, ranges, typing, removed });
          leaveAfter(caretKey, typingMs + ACTIVITY_SHOWN_MS.editing);
        });
        this.storage.unsubscribe = () => {
          stopActivity();
          stopEdit();
          timers.forEach(clearTimeout);
          playbacks.forEach((timers) => timers.forEach(clearTimeout));
        };
      },
      onDestroy() {
        this.storage.unsubscribe?.();
      },
      addProseMirrorPlugins() {
        return [agentCaretsPlugin(userId), remoteChangePlugin()];
      },
    }
  );
