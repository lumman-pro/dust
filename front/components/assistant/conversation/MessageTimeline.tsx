import type { AgentMessageWithStreaming } from "@app/components/assistant/conversation/types";
import type { MessageTimelineStore } from "@app/components/assistant/conversation/useMessageTimeline";
import type { UserMessageTypeWithContentFragments } from "@app/types/assistant/conversation";
import { removeNulls } from "@app/types/shared/utils/general";
import { stripMarkdown } from "@app/types/shared/utils/markdown";
import { cn } from "@dust-tt/sparkle";
import { useLingui } from "@lingui/react/macro";
import type { WheelEvent } from "react";
import { useState, useSyncExternalStore } from "react";

// Width of a bar by its distance to the closest highlighted bar (dock-style magnification): 20px down
// to 8px in 4px steps over three neighbors, then the resting width. Widths rather than a horizontal
// scale, which would squash the rounded ends of the narrower bars.
const BAR_WIDTH_CLASS_BY_HIGHLIGHT_DISTANCE = ["w-5", "w-4", "w-3", "w-2"];
const RESTING_BAR_WIDTH_CLASS = "w-1.5";

// `stripMarkdown` keeps citation directives, which mean nothing without their sources.
const CITATION_DIRECTIVE_REGEX = /\s*:cite\[[^\]]*\]/g;

function getBarWidthClass(index: number, highlightedIndices: number[]): string {
  const distance = Math.min(
    ...highlightedIndices.map((highlightedIndex) =>
      Math.abs(index - highlightedIndex)
    )
  );

  return (
    BAR_WIDTH_CLASS_BY_HIGHLIGHT_DISTANCE[distance] ?? RESTING_BAR_WIDTH_CLASS
  );
}

interface HoveredTimelineMessage {
  index: number;
  message: UserMessageTypeWithContentFragments;
  answer: AgentMessageWithStreaming | null;
}

interface MessageTimelinePreviewCardProps {
  message: UserMessageTypeWithContentFragments;
  answer: AgentMessageWithStreaming | null;
  // Vertical center of the card, as a fraction of the bars column height.
  center: number;
}

function MessageTimelinePreviewCard({
  message,
  answer,
  center,
}: MessageTimelinePreviewCardProps) {
  const answerText = answer?.content
    ? stripMarkdown(answer.content).replace(CITATION_DIRECTIVE_REGEX, "")
    : null;

  // `bg-overlay-background` brings Sparkle's overlay elevation shadow. The card stays mounted while
  // the pointer moves between bars: it fades in once, then slides from bar to bar.
  return (
    <div
      aria-hidden
      className={cn(
        "dd-privacy-mask pointer-events-none absolute right-full w-88 -translate-y-1/2",
        "rounded-xl border bg-overlay-background px-4 py-3",
        "transition-[top] animate-in fade-in-0 zoom-in-95",
        "motion-reduce:animate-none motion-reduce:transition-none"
      )}
      style={{ top: `${center * 100}%` }}
    >
      <div className="truncate text-sm text-foreground">
        {stripMarkdown(message.content)}
      </div>
      {answerText && (
        <div className="mt-1 line-clamp-3 text-sm text-muted-foreground">
          {answerText}
        </div>
      )}
    </div>
  );
}

interface MessageTimelineProps {
  store: MessageTimelineStore;
  getMessageAnswer: (
    message: UserMessageTypeWithContentFragments
  ) => AgentMessageWithStreaming | null;
  onMessageClick: (message: UserMessageTypeWithContentFragments) => void;
  onWheel: (event: WheelEvent<HTMLElement>) => void;
}

export function MessageTimeline({
  store,
  getMessageAnswer,
  onMessageClick,
  onWheel,
}: MessageTimelineProps) {
  const { t } = useLingui();
  const { messages, activeMessageId } = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  );
  const [hovered, setHovered] = useState<HoveredTimelineMessage | null>(null);

  if (messages.length < 2) {
    return null;
  }

  const activeIndex = messages.findIndex((m) => m.sId === activeMessageId);
  // The bar of the message in view stays highlighted while another bar is hovered, each one
  // magnifying its own neighbors.
  const highlightedIndices = removeNulls([
    hovered?.index ?? null,
    activeIndex === -1 ? null : activeIndex,
  ]);

  // The answer is read when a bar gets hovered rather than kept in sync with the list, so that
  // streaming answers do not re-render the timeline on every update.
  const hoverMessage = (
    index: number,
    message: UserMessageTypeWithContentFragments
  ) => setHovered({ index, message, answer: getMessageAnswer(message) });

  // The timeline sits in the right gutter of the list, clear of the scrollbar. The container's padding
  // is the gutter the bars need on each side (16px inset, 20px bar, 20px clearance), so the timeline
  // only shows when what remains fits the message column: `@min-conversation` compares the container
  // to `--container-conversation` (`max-w-conversation`), not to the `conversation` named container.
  // The vertical padding keeps the first and last bars far enough from the pane edges for their card,
  // at most 110px tall and centered on the bar, to fit.
  return (
    <div className="pointer-events-none absolute inset-0 px-14 @container">
      <nav
        aria-label={t`Message timeline`}
        className={cn(
          "absolute inset-y-0 right-4 hidden w-8 flex-col justify-center py-14",
          "@min-conversation:flex"
        )}
      >
        <div
          className="pointer-events-auto relative flex max-h-full flex-col"
          onMouseLeave={() => setHovered(null)}
          onWheel={onWheel}
        >
          {hovered && (
            <MessageTimelinePreviewCard
              message={hovered.message}
              answer={hovered.answer}
              // Bars all have the same height, so the center of the hovered one is at
              // (index + 1/2) / count of the column.
              center={(hovered.index + 0.5) / messages.length}
            />
          )}
          {messages.map((message, index) => {
            const messageNumber = index + 1;

            return (
              <button
                key={message.sId}
                type="button"
                aria-label={t`Go to message ${messageNumber}`}
                aria-current={index === activeIndex ? "location" : undefined}
                className="flex h-3 min-h-1 w-full items-center justify-end outline-hidden"
                onClick={() => onMessageClick(message)}
                onMouseEnter={() => hoverMessage(index, message)}
                onFocus={() => hoverMessage(index, message)}
                onBlur={() => setHovered(null)}
              >
                <span
                  className={cn(
                    "h-0.5 rounded-full",
                    getBarWidthClass(index, highlightedIndices),
                    "transition-[width,background-color] duration-150 ease-enter",
                    "motion-reduce:transition-none",
                    index === hovered?.index || index === activeIndex
                      ? "bg-foreground"
                      : "bg-muted-foreground/40"
                  )}
                />
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
