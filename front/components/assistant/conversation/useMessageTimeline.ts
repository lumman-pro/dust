import type {
  AgentMessageWithStreaming,
  VirtuosoMessage,
  VirtuosoMessageListContext,
} from "@app/components/assistant/conversation/types";
import {
  isAgentMessageWithStreaming,
  isHiddenMessage,
  isUserMessage,
} from "@app/components/assistant/conversation/types";
import { wheelDeltaPx } from "@app/lib/client/wheel";
import type { UserMessageTypeWithContentFragments } from "@app/types/assistant/conversation";
import type {
  ItemLocationWithAlign,
  VirtuosoMessageListMethods,
} from "@virtuoso.dev/message-list";
import type { RefObject, UIEvent, WheelEvent } from "react";
import { useCallback, useRef, useState } from "react";

type MessageListMethods = VirtuosoMessageListMethods<
  VirtuosoMessage,
  VirtuosoMessageListContext
>;

function isMessageTimelineEntry(
  message: VirtuosoMessage
): message is UserMessageTypeWithContentFragments {
  return isUserMessage(message) && !isHiddenMessage(message);
}

interface MessageRowOffsets {
  top: number;
  bottom: number;
}

/**
 * Offsets from the top of the list of the rows rendered by `MessageItem`, which tags the root of each
 * message row with `data-message-id`. Offsets are measured from the element holding the rows rather
 * than from the viewport: while Virtuoso positions the list, it shifts that element without
 * scrolling, so positions in the viewport go stale until the next scroll event.
 */
function getRenderedMessageRowOffsets(
  scroller: HTMLElement
): Map<string, MessageRowOffsets> {
  const offsets = new Map<string, MessageRowOffsets>();
  const rows = scroller.querySelectorAll<HTMLElement>("[data-message-id]");
  let rowsContainer = rows[0];
  if (!rowsContainer) {
    return offsets;
  }
  while (
    rowsContainer.parentElement &&
    rowsContainer.parentElement !== scroller
  ) {
    rowsContainer = rowsContainer.parentElement;
  }

  const containerTop = rowsContainer.getBoundingClientRect().top;
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    if (row.dataset.messageId) {
      offsets.set(row.dataset.messageId, {
        top: rect.top - containerTop,
        bottom: rect.bottom - containerTop,
      });
    }
  }

  return offsets;
}

/**
 * Height of the viewport of the list that the input bar, its sticky footer, does not cover.
 */
function getVisibleListHeight(scroller: HTMLElement): number {
  const stickyFooter = [...scroller.children].find(
    (child) => getComputedStyle(child).position === "sticky"
  );

  return (
    scroller.clientHeight -
    (stickyFooter ? stickyFooter.getBoundingClientRect().height : 0)
  );
}

/**
 * Returns the timeline entry of the conversation turn being read: the last one whose top has passed
 * the upper third of the visible list (the viewport above the input bar), or the last one once the
 * end of the list is visible, since short last turns can never reach the top. Reads the rendered rows
 * rather than Virtuoso's scroll location, which is frozen while it scrolls programmatically.
 */
function getActiveMessageTimelineEntry(
  list: MessageListMethods
): UserMessageTypeWithContentFragments | null {
  const scroller = list.scrollerElement();
  if (!scroller) {
    return null;
  }

  const offsets = getRenderedMessageRowOffsets(scroller);
  const visibleListHeight = getVisibleListHeight(scroller);
  const activationLine = scroller.scrollTop + visibleListHeight / 3;
  const messages = list.data.get();

  let active: UserMessageTypeWithContentFragments | null = null;
  let last: UserMessageTypeWithContentFragments | null = null;
  // Virtuoso renders a contiguous range of messages: the ones before it are above the viewport and
  // the ones after it are below.
  let hasReachedRenderedRows = false;
  for (const message of messages) {
    const offset = offsets.get(message.sId);
    hasReachedRenderedRows ||= offset !== undefined;
    if (!isMessageTimelineEntry(message)) {
      continue;
    }

    const hasPassedActivationLine = offset
      ? offset.top <= activationLine
      : !hasReachedRenderedRows;
    if (active === null || hasPassedActivationLine) {
      active = message;
    }
    last = message;
  }

  const lastMessage = messages.at(-1);
  const lastOffset = lastMessage ? offsets.get(lastMessage.sId) : undefined;
  // One pixel of tolerance: `scrollTop` is whole pixels while row heights are not.
  const isEndInView =
    lastOffset !== undefined &&
    lastOffset.bottom <= scroller.scrollTop + visibleListHeight + 1;

  return isEndInView ? last : active;
}

/**
 * Whether the message is rendered and intersects the visible list (the viewport above the input bar).
 */
function isMessageInViewport(
  list: MessageListMethods,
  messageId: string
): boolean {
  const scroller = list.scrollerElement();
  const offset = scroller
    ? getRenderedMessageRowOffsets(scroller).get(messageId)
    : undefined;
  if (!scroller || !offset) {
    return false;
  }

  return (
    offset.top < scroller.scrollTop + getVisibleListHeight(scroller) &&
    offset.bottom > scroller.scrollTop
  );
}

interface MessageTimelineSnapshot {
  messages: UserMessageTypeWithContentFragments[];
  activeMessageId: string | null;
}

/**
 * State of the message timeline, kept outside React: the list updates it on every scroll event, and
 * only the timeline subscribes to it, so the conversation does not re-render when it changes.
 */
export class MessageTimelineStore {
  private snapshot: MessageTimelineSnapshot = {
    messages: [],
    activeMessageId: null,
  };
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): MessageTimelineSnapshot => this.snapshot;

  // Keeps the previous array while the entries are unchanged to avoid re-rendering the timeline on
  // every scroll event.
  setMessages(messages: UserMessageTypeWithContentFragments[]) {
    const current = this.snapshot.messages;
    if (
      current.length === messages.length &&
      current.every((message, index) => message === messages[index])
    ) {
      return;
    }

    this.snapshot = { ...this.snapshot, messages };
    this.notify();
  }

  setActiveMessageId(activeMessageId: string | null) {
    if (activeMessageId === this.snapshot.activeMessageId) {
      return;
    }

    this.snapshot = { ...this.snapshot, activeMessageId };
    this.notify();
  }

  private notify() {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

interface UseMessageTimelineProps {
  virtuosoMessageListRef: RefObject<MessageListMethods>;
  isEnabled: boolean;
  // Scroll animation used to jump to a message of the timeline.
  scrollBehavior: ItemLocationWithAlign["behavior"];
}

/**
 * Keeps the message timeline of a conversation in sync with the Virtuoso list: its entries (one per
 * visible user message) and the message being read.
 *
 * Virtuoso exposes no subscription to its data, so the caller calls `syncTimeline` from the list's
 * `onRenderedDataChange` and passes `onScrollerScroll` to its `onScrollCapture`.
 */
export function useMessageTimeline({
  virtuosoMessageListRef,
  isEnabled,
  scrollBehavior,
}: UseMessageTimelineProps) {
  const [timelineStore] = useState(() => new MessageTimelineStore());
  // Message clicked in the timeline. It stays active while the list scrolls to it and until it
  // leaves the viewport, even when the list cannot bring it to the top (last messages).
  const pinnedTimelineMessageRef = useRef<{
    sId: string;
    isScrolling: boolean;
  } | null>(null);

  const syncTimeline = useCallback(() => {
    if (!isEnabled || !virtuosoMessageListRef.current) {
      return;
    }

    timelineStore.setMessages(
      virtuosoMessageListRef.current.data.get().filter(isMessageTimelineEntry)
    );

    if (pinnedTimelineMessageRef.current) {
      return;
    }

    const activeEntry = getActiveMessageTimelineEntry(
      virtuosoMessageListRef.current
    );
    timelineStore.setActiveMessageId(activeEntry?.sId ?? null);
  }, [isEnabled, timelineStore, virtuosoMessageListRef]);

  // Virtuoso's `onScroll` is muted while it scrolls programmatically (initial positioning, jump to a
  // sent message), so the timeline follows the scroller's own scroll events.
  const onScrollerScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) {
        return;
      }

      const pinned = pinnedTimelineMessageRef.current;
      if (
        pinned &&
        !pinned.isScrolling &&
        virtuosoMessageListRef.current &&
        !isMessageInViewport(virtuosoMessageListRef.current, pinned.sId)
      ) {
        pinnedTimelineMessageRef.current = null;
      }
      syncTimeline();
    },
    [syncTimeline, virtuosoMessageListRef]
  );

  // The bars are not inside the list's scroller, so the wheel over them would not scroll the
  // conversation on its own.
  const onTimelineWheel = useCallback(
    (event: WheelEvent<HTMLElement>) => {
      const scroller = virtuosoMessageListRef.current?.scrollerElement();
      if (!scroller) {
        return;
      }

      scroller.scrollBy({
        top: wheelDeltaPx(event.nativeEvent, scroller.clientHeight),
      });
    },
    [virtuosoMessageListRef]
  );

  const getTimelineMessageAnswer = useCallback(
    (
      message: UserMessageTypeWithContentFragments
    ): AgentMessageWithStreaming | null => {
      if (!virtuosoMessageListRef.current) {
        return null;
      }

      const answer = virtuosoMessageListRef.current.data.find(
        (m) =>
          isAgentMessageWithStreaming(m) && m.parentMessageId === message.sId
      );
      return answer && isAgentMessageWithStreaming(answer) ? answer : null;
    },
    [virtuosoMessageListRef]
  );

  const scrollToTimelineMessage = useCallback(
    (message: UserMessageTypeWithContentFragments) => {
      if (!virtuosoMessageListRef.current) {
        return;
      }

      const index = virtuosoMessageListRef.current.data.findIndex(
        (m) => m.sId === message.sId
      );
      if (index === -1) {
        return;
      }

      pinnedTimelineMessageRef.current = {
        sId: message.sId,
        isScrolling: true,
      };
      timelineStore.setActiveMessageId(message.sId);

      // "start-no-overflow" stops at the end of the list for the last messages instead of padding
      // the bottom of the list with blank space to bring them to the top.
      virtuosoMessageListRef.current.scrollToItem({
        index,
        align: "start-no-overflow",
        behavior: scrollBehavior,
        done: () => {
          if (pinnedTimelineMessageRef.current?.sId === message.sId) {
            pinnedTimelineMessageRef.current = {
              sId: message.sId,
              isScrolling: false,
            };
          }
        },
      });
    },
    [scrollBehavior, timelineStore, virtuosoMessageListRef]
  );

  return {
    timelineStore,
    syncTimeline,
    onScrollerScroll,
    onTimelineWheel,
    getTimelineMessageAnswer,
    scrollToTimelineMessage,
  };
}
