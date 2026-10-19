import { MCP_VALIDATION_OUTPUTS } from "@app/lib/actions/constants";
import { FramePublicationTargetSchema } from "@app/types/api/frame_publication";
import { isValidSandboxFunctionSlug } from "@app/types/api/sandbox_functions";
import { z } from "zod";

export const FrameFunctionInvocationParamsSchema = z.object({
  frameId: z.string().min(1),
  name: z.string().refine(isValidSandboxFunctionSlug),
});

export const PostFrameFunctionInvocationBodySchema = z
  .object({
    input: z.unknown().optional(),
    context: z
      .object({
        timezone: z.string().optional(),
      })
      .optional(),
    target: FramePublicationTargetSchema.optional(),
  })
  .strict();

export const FrameFunctionInvocationActionParamsSchema = z.object({
  frameId: z.string().min(1),
  invocationId: z.string().min(1),
  actionId: z.string().min(1),
});

export const ValidateFrameFunctionActionBodySchema = z
  .object({
    approved: z.enum(MCP_VALIDATION_OUTPUTS),
  })
  .strict();

export const ResolveFrameFunctionAuthenticationBodySchema = z
  .object({
    outcome: z.enum(["completed", "denied"]),
  })
  .strict();
