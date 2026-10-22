import { AGENT_EDIT_SHOWN_MS } from "@app/components/editor/document/AgentCarets";
import type { AgentEvent } from "@app/lib/client/collab/agents";
import { onAgentActivity } from "@app/lib/client/collab/agents";
import type { DocumentActivity } from "@app/types/collab";
import { isDocumentActivity } from "@app/types/collab";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { useEffect, useState } from "react";

// Long enough for the model to write most changes after reading, short enough not to linger once an
// agent answers without editing: the session has no "done" signal.
const READING_SHOWN_MS = 20_000;
// As long as the agent's caret shows after its longest edit.
const EDITING_SHOWN_MS = AGENT_EDIT_SHOWN_MS;

/**
 * @cc [owner:PopDaph,label:product] collab-agent-activity-shown
 * The activity MUST be the last read or edit the session announced on `provider` for an agent
 * without `commentId`, for `READING_SHOWN_MS` after a read and `EDITING_SHOWN_MS` after an edit,
 * then none. Any other activity, and any activity of an agent with a `commentId`, MUST change
 * nothing. A new provider MUST start with none.
 */
export function useCollabAgentActivity(
  provider: HocuspocusProvider | null
): AgentEvent<DocumentActivity> | null {
  // Kept with its provider: until the effect's cleanup runs, a new provider would see the old one's.
  const [shown, setShown] = useState<{
    provider: HocuspocusProvider;
    event: AgentEvent<DocumentActivity>;
  } | null>(null);

  useEffect(() => {
    if (!provider) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = onAgentActivity(provider, ({ agent, activity }) => {
      if (agent.commentId || !isDocumentActivity(activity)) {
        return;
      }
      clearTimeout(timer);
      setShown({ provider, event: { agent, activity } });
      timer = setTimeout(
        () => setShown(null),
        activity === "editing" ? EDITING_SHOWN_MS : READING_SHOWN_MS
      );
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
      setShown(null);
    };
  }, [provider]);

  return shown?.provider === provider ? shown.event : null;
}
