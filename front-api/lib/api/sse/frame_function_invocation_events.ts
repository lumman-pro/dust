import {
  getSandboxFunctionInvocationEvents,
  getSandboxFunctionInvocationEventsBatch,
} from "@app/lib/api/sandbox_functions/events";
import { resolveFrameFunctionInvocationForUse } from "@app/lib/api/sandbox_functions/frame_share_capability";
import type { Authenticator } from "@app/lib/auth";
import { pollEvents } from "@front-api/lib/api/sse/poll_events";
import { streamEvents } from "@front-api/lib/api/sse/stream_events";
import type { Context } from "hono";
import { z } from "zod";

export const FrameFunctionInvocationEventParamSchema = z.object({
  frameId: z.string().min(1),
  invocationId: z.string().min(1),
});

export async function streamFrameFunctionInvocationEventsForRoute(
  ctx: Context,
  auth: Authenticator,
  {
    frameId,
    invocationId,
    lastEventId,
  }: {
    frameId: string;
    invocationId: string;
    lastEventId: string | null;
  },
  transport: "sse" | "poll" = "sse"
) {
  const invocation = await resolveFrameFunctionInvocationForUse(auth, {
    frameId,
    invocationId,
  });
  if (!invocation) {
    return ctx.notFound();
  }

  if (transport === "poll") {
    return pollEvents(ctx, async (signal) => {
      const events = await getSandboxFunctionInvocationEventsBatch({
        invocationId: invocation.sId,
        lastEventId,
        signal,
      });
      return { events: events.map((event) => JSON.stringify(event)) };
    });
  }

  return streamEvents({
    ctx,
    iterator: (signal) =>
      getSandboxFunctionInvocationEvents({
        invocationId: invocation.sId,
        lastEventId,
        signal,
      }),
    writeDoneSentinel: true,
  });
}
