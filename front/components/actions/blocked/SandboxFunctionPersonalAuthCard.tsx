import type { PersonalAuthResolutionOutcome } from "@app/components/actions/blocked/PersonalAuthenticationCard";
import { PersonalAuthenticationCard } from "@app/components/actions/blocked/PersonalAuthenticationCard";
import type { FrameViewer } from "@app/components/assistant/conversation/actions/VisualizationActionIframe";
import type { SandboxFunctionToolPersonalAuthRequiredEvent } from "@app/lib/actions/mcp_internal_actions/events";
import { useResolveAuthentication } from "@app/lib/swr/tool_actions";

interface SandboxFunctionPersonalAuthCardProps {
  // Every invocation blocked on this MCP server: one trip through the authentication flow resolves
  // them all, so they must not be presented (and resolved) one card at a time.
  events: SandboxFunctionToolPersonalAuthRequiredEvent[];
  // The Frame whose function invocations the events belong to.
  frameId: string;
  // Viewer context is passed in: shared frames render this card outside of any AuthProvider.
  viewer: FrameViewer;
  onResolved: () => void;
}

export function SandboxFunctionPersonalAuthCard({
  events,
  frameId,
  viewer,
  onResolved,
}: SandboxFunctionPersonalAuthCardProps) {
  const [{ authError }] = events;

  const { resolveAuthentication, isResolving } = useResolveAuthentication({
    owner: viewer.owner,
  });

  const handleResolve = async (
    outcome: PersonalAuthResolutionOutcome
  ): Promise<boolean> => {
    for (const event of events) {
      const result = await resolveAuthentication({
        contextType: "sandbox_function",
        frameId,
        invocationId: event.invocationId,
        actionId: event.actionId,
        outcome,
      });

      if (!result.success) {
        return false;
      }
    }

    onResolved();
    return true;
  };

  return (
    <PersonalAuthenticationCard
      triggeringUser={viewer.user}
      currentUser={viewer.user}
      mcpServerId={authError.mcpServerId}
      owner={viewer.owner}
      provider={authError.provider}
      scope={authError.scope}
      isResolving={isResolving}
      onResolve={handleResolve}
    />
  );
}
