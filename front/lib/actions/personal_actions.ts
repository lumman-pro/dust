import type { MCPOAuthUseCase } from "@app/types/oauth/lib";
import { assertNever } from "@app/types/shared/utils/assert_never";

/**
 * @cc [owner:tdraier,label:security] authorless-messages-skip-personal-servers
 * A server view scoped to `personal_actions` MUST be reported not usable when the user message
 * being answered has no author (`user` is null, posted by Dust on someone's behalf). Every surface
 * that lists or runs tools for an agent message (agent-loop tool listing and execution, `toolsets`
 * list and enable, sandbox `dsbx` listing and `/call`) MUST apply this check, so no path runs such a
 * server. Execution MUST check the view as fetched at call time, not as it was when listed.
 */
export function isServerUsableForMessage(
  view: { oAuthUseCase: MCPOAuthUseCase | null },
  { isWithoutConcreteUser }: { isWithoutConcreteUser: boolean }
): boolean {
  return !isWithoutConcreteUser || view.oAuthUseCase !== "personal_actions";
}

export const PERSONAL_SERVER_UNUSABLE_MESSAGE =
  "These tools run on each person's own credentials, and the message being answered was posted " +
  "by Dust on someone's behalf rather than written by a person, so they cannot be used here.";

/**
 * Model-facing note appended to tool descriptions so the agent knows which
 * credential mode the server is configured with. Null when the server has no
 * OAuth use case (no credentials involved).
 */
export function getCredentialModeDescriptionNote(
  oAuthUseCase: MCPOAuthUseCase | null
): string | null {
  switch (oAuthUseCase) {
    case "personal_actions":
      return "Note: Uses each user's personal credentials.";
    case "platform_actions":
      return "Note: Uses the workspace shared credentials.";
    case null:
      return null;
    default:
      assertNever(oAuthUseCase);
  }
}
