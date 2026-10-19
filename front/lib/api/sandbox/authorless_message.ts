import type { Authenticator } from "@app/lib/auth";
import type { ConversationResource } from "@app/lib/resources/conversation_resource";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";

export async function isAgentMessageAnsweringAuthorlessMessage(
  auth: Authenticator,
  {
    conversation,
    agentMessageId,
  }: { conversation: ConversationResource; agentMessageId: string }
): Promise<Result<boolean, Error>> {
  const agentMessageRes = await conversation.getMessageById(
    auth,
    agentMessageId
  );
  if (agentMessageRes.isErr() || !agentMessageRes.value.parentId) {
    return new Err(new Error("Agent message not found."));
  }

  const [userMessageRow] = await conversation.fetchMessagesByModelIds(auth, [
    agentMessageRes.value.parentId,
  ]);
  if (!userMessageRow?.userMessage) {
    return new Err(new Error("User message not found."));
  }

  return new Ok(userMessageRow.userMessage.userId === null);
}
