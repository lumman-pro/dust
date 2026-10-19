import { MCPError } from "@app/lib/actions/mcp_errors";
import type { ToolHandlerResult } from "@app/lib/actions/mcp_internal_actions/tool_definition";
import { Err, Ok, type Result } from "@app/types/shared/result";
import { checkWriteSteps } from "@extension/platforms/excel/tools/checkSteps";
import {
  parseExpression,
  type Step,
} from "@extension/platforms/excel/tools/parseExpression";
import { resolveSteps } from "@extension/platforms/excel/tools/resolveSteps";
import { normalizeError } from "@extension/shared/lib/utils";

type WorkbookWrite = { expression: string };

/**
 * Phase 1, outside Excel.run: parses and checks every write, and gives the steps of each one.
 * Nothing touches Excel yet.
 */
function parseAndCheckWrites(
  writes: WorkbookWrite[]
): Result<Step[][], string> {
  const parsed: Step[][] = [];
  for (const [index, { expression }] of writes.entries()) {
    const steps = parseExpression(expression);
    if (steps.isErr()) {
      return new Err(`Write ${index}: invalid expression: ${steps.error}`);
    }
    const check = checkWriteSteps(steps.value);
    if (check.isErr()) {
      return new Err(`Write ${index}: ${check.error}`);
    }
    parsed.push(steps.value);
  }
  return new Ok(parsed);
}

/**
 * Phase 2, inside Excel.run: does the steps of every write, in the order of the input. The last
 * step of each expression is its write. Still one batch, nothing sent: an Office.js call only
 * adds a command to the queue of the context.
 */
function queueWrites(
  workbook: Excel.Workbook,
  writes: Step[][]
): Result<undefined, string> {
  for (const [index, steps] of writes.entries()) {
    const resolved = resolveSteps(workbook, steps);
    if (resolved.isErr()) {
      return new Err(`Write ${index}: ${resolved.error}`);
    }
  }
  return new Ok(undefined);
}

export async function writeWorkbookTool({
  writes,
}: {
  writes: WorkbookWrite[];
}): Promise<ToolHandlerResult> {
  const parsed = parseAndCheckWrites(writes);
  if (parsed.isErr()) {
    return new Err(new MCPError(parsed.error));
  }

  try {
    const result = await Excel.run(async (context) => {
      const queued = queueWrites(context.workbook, parsed.value);
      if (queued.isErr()) {
        return new Err(queued.error);
      }
      // Phase 3: one round trip to Excel does every write.
      await context.sync();
      return new Ok(undefined);
    });
    if (result.isErr()) {
      return new Err(new MCPError(result.error));
    }
    return new Ok([
      {
        type: "text",
        text: `Applied ${writes.length} writes to the workbook.`,
      },
    ]);
  } catch (error) {
    // Office.js rejects with an OfficeExtension.Error, e.g. `ItemNotFound` for an unknown sheet.
    // The error says which write failed. The writes before it in the same call can be applied,
    // so the caller reads the workbook again to see its state.
    return new Err(
      new MCPError(
        `Failed to write to the workbook: ${normalizeError(error).message}`
      )
    );
  }
}
