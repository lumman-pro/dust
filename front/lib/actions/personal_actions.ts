import type { MCPOAuthUseCase } from "@app/types/oauth/lib";

/**
 * @cc [owner:tdraier,label:security] authorless-messages-skip-personal-servers
 * A server view scoped to `personal_actions` MUST be reported not usable when the user message
 * being answered has no author (`user` is null, posted by Dust on someone's behalf). Every surface
 * that lists or runs tools for an agent message (agent-loop tool listing, `toolsets` list and
 * enable, sandbox `dsbx` listing and `/call`) MUST apply this check, so no path runs such a server.
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
