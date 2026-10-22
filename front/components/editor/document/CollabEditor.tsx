import { buildCollabExtensions } from "@app/components/editor/document/collabExtensions";
import { DocumentView } from "@app/components/editor/document/DocumentEditor";
import type {
  CollabConnectionSettings,
  DocumentProps,
} from "@app/components/editor/document/types";
import { useCollabAgentActivity } from "@app/components/editor/document/useCollabAgentActivity";
import { useCollabParticipants } from "@app/components/editor/document/useCollabParticipants";
import {
  useCommentAgentActivities,
  workingCommentAgent,
} from "@app/components/editor/document/useCommentAgentActivities";
import { useImageSourceResolver } from "@app/components/editor/document/useImageSourceResolver";
import { useShowSaving } from "@app/components/editor/document/useShowSaving";
import { useCollabConnection } from "@app/hooks/useCollabConnection";
import { useLingui } from "@lingui/react/macro";
import { useMemo, useState } from "react";

interface CollabEditorProps extends DocumentProps {
  live: CollabConnectionSettings;
}

/** A Document in a live session: the file read-only until the shared document has synced. */
/**
 * @cc [owner:PopDaph,label:product] collab-caret-on-open
 * Only the editor bound to the first connection MUST get `focusOnOpen`: an editor bound to a later
 * connection, after a reconnect, MUST NOT move the caret.
 */
/**
 * @cc [owner:tdraier,label:product] collab-read-only-scope
 * A document bound to a connection the server authorized read-only MUST be read-only, whatever
 * `readOnly` the host passes: the server ignores that connection's edits.
 */
export default function CollabEditor(props: CollabEditorProps) {
  const { t } = useLingui();
  const { connection, status, syncingSinceMs, saveState } = useCollabConnection(
    props.live
  );
  // Here rather than in the icon, which mounts again with each connection.
  const showSaving = useShowSaving(syncingSinceMs);
  const conversationAgent = useCollabAgentActivity(
    connection?.provider ?? null
  );
  const commentAgents = useCommentAgentActivities(
    connection?.provider ?? null,
    connection?.comments ?? null
  );
  const agent = conversationAgent ?? workingCommentAgent(commentAgents);
  const { id, name, color } = props.live.user;
  const participants = useCollabParticipants(
    connection?.provider.awareness ?? null
  );
  const resolveImageSource = useImageSourceResolver(props.resolveImageSource);
  const [openedConnectionId, setOpenedConnectionId] = useState<number | null>(
    null
  );
  if (connection && openedConnectionId === null) {
    setOpenedConnectionId(connection.id);
  }
  const extensions = useMemo(
    () =>
      connection
        ? buildCollabExtensions({
            t,
            document: connection.document,
            awareness: connection.provider.awareness,
            user: { id, name, color },
            comments: connection.comments,
            resolveImageSource,
            provider: connection.provider,
          })
        : null,
    [t, connection, id, name, color, resolveImageSource]
  );

  return connection && extensions ? (
    // A new connection is a new shared document: the editor binds to it from scratch.
    <DocumentView
      key={connection.id}
      {...props}
      readOnly={
        props.readOnly || connection.provider.authorizedScope === "readonly"
      }
      collabView={{
        status,
        showSaving,
        saveFailed: saveState.failed,
        conflictCopy: saveState.conflictCopy,
        agent,
        commentAgents,
        participants,
        binding: {
          extensions,
          connected: status === "live",
          comments: connection.comments,
          focusOnOpen: connection.id === openedConnectionId,
        },
      }}
    />
  ) : (
    <DocumentView {...props} collabView={{ status, binding: null }} />
  );
}
