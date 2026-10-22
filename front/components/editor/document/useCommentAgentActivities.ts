import { AGENT_EDIT_SHOWN_MS } from "@app/components/editor/document/AgentCarets";
import type { AgentEvent } from "@app/lib/client/collab/agents";
import { onAgentActivity } from "@app/lib/client/collab/agents";
import type { CommentChannel } from "@app/lib/client/collab/comments";
import type { WorkingAgentActivity } from "@app/types/collab";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { useEffect, useState } from "react";

// A read or an edit is a moment of the run: the agent thinks again once it is shown.
export const READ_THEN_THINKING_MS = 3_000;
const EDIT_THEN_THINKING_MS = AGENT_EDIT_SHOWN_MS;
// Only for a run that never replies, such as one that failed.
export const RUN_SHOWN_MS = 10 * 60 * 1000;

const EMPTY: ReadonlyMap<string, AgentEvent> = new Map();

/**
 * @cc [owner:adrien,label:product] comment-agent-activities
 * Each thread MUST map to the last activity the session announced on `provider` for an agent
 * carrying its id as `commentId`, until, in `comments`, a message of that agent added to the
 * thread since it stopped waiting, then none; a message added while it waits MUST NOT end it, and
 * when `comments` has no threads yet as it stops waiting, only messages added after its first
 * threads count. A
 * read MUST show as thinking `READ_THEN_THINKING_MS` later and an edit `EDIT_THEN_THINKING_MS`
 * later; a thread MUST show none `RUN_SHOWN_MS` after its last announcement. An activity without
 * `commentId` MUST be ignored.
 * A new provider MUST start with none.
 */
export function useCommentAgentActivities(
  provider: HocuspocusProvider | null,
  comments: CommentChannel | null
): ReadonlyMap<string, AgentEvent> {
  const [shown, setShown] = useState<{
    provider: HocuspocusProvider;
    activities: ReadonlyMap<string, AgentEvent>;
  } | null>(null);

  useEffect(() => {
    if (!provider) {
      return;
    }
    const runs = new Map<
      string,
      {
        agentId: string;
        waiting: boolean;
        repliesFrom: number | null;
        timers: ReturnType<typeof setTimeout>[];
      }
    >();
    const update = (commentId: string, event: AgentEvent | null) =>
      setShown((last) => {
        const current = last?.provider === provider ? last.activities : EMPTY;
        if (!event && !current.has(commentId)) {
          return last;
        }
        const activities = new Map(current);
        if (event) {
          activities.set(commentId, event);
        } else {
          activities.delete(commentId);
        }
        return { provider, activities };
      });
    const end = (commentId: string) => {
      runs.get(commentId)?.timers.forEach(clearTimeout);
      runs.delete(commentId);
      update(commentId, null);
    };
    const stopThreads = comments?.onThreads((threads) => {
      const messagesById = new Map(
        threads.map(({ id, messages }) => [id, messages])
      );
      runs.forEach((run, commentId) => {
        const messages = messagesById.get(commentId) ?? [];
        if (run.repliesFrom === null) {
          run.repliesFrom = messages.length;
          return;
        }
        const replied =
          !run.waiting &&
          messages
            .slice(run.repliesFrom)
            .some(
              ({ author }) =>
                author.kind === "agent" && author.id === run.agentId
            );
        if (replied) {
          end(commentId);
        }
      });
    });
    const unsubscribe = onAgentActivity(provider, ({ agent, activity }) => {
      const { commentId } = agent;
      if (!commentId) {
        return;
      }
      const run = runs.get(commentId);
      run?.timers.forEach(clearTimeout);
      const waiting = activity === "waiting";
      const repliesFrom =
        run && run.agentId === agent.agentId && !run.waiting && !waiting
          ? run.repliesFrom
          : threadLength(comments, commentId);
      const timers = [setTimeout(() => end(commentId), RUN_SHOWN_MS)];
      if (activity === "reading" || activity === "editing") {
        timers.push(
          setTimeout(
            () => update(commentId, { agent, activity: "thinking" }),
            activity === "editing"
              ? EDIT_THEN_THINKING_MS
              : READ_THEN_THINKING_MS
          )
        );
      }
      runs.set(commentId, {
        agentId: agent.agentId,
        waiting,
        repliesFrom,
        timers,
      });
      update(commentId, { agent, activity });
    });
    return () => {
      unsubscribe();
      stopThreads?.();
      runs.forEach(({ timers }) => timers.forEach(clearTimeout));
      setShown(null);
    };
  }, [provider, comments]);

  return shown?.provider === provider ? shown.activities : EMPTY;
}

function threadLength(
  comments: CommentChannel | null,
  commentId: string
): number | null {
  const threads = comments?.getThreads();
  if (!threads) {
    return null;
  }
  return threads.find(({ id }) => id === commentId)?.messages.length ?? 0;
}

/**
 * @cc [owner:adrien,label:product] working-comment-agent
 * The agent MUST be one of `activities` that is not waiting, with the activity its thread shows, or
 * none when each one waits.
 */
export function workingCommentAgent(
  activities: ReadonlyMap<string, AgentEvent>
): AgentEvent<WorkingAgentActivity> | null {
  for (const { agent, activity } of activities.values()) {
    if (activity !== "waiting") {
      return { agent, activity };
    }
  }
  return null;
}
