import { MCPError } from "@app/lib/actions/mcp_errors";
import type { ToolHandlerResult } from "@app/lib/actions/mcp_internal_actions/tool_definition";
import { Err, Ok, type Result } from "@app/types/shared/result";
import { pluralize } from "@app/types/shared/utils/string_utils";
import { checkWriteSteps } from "@extension/platforms/excel/tools/checkSteps";
import {
  parseExpression,
  type Step,
} from "@extension/platforms/excel/tools/parseExpression";
import { resolveSteps } from "@extension/platforms/excel/tools/resolveSteps";
import { normalizeError } from "@extension/shared/lib/utils";

type WorkbookWrite = { expression: string };

// One write after the checks: the steps of its expression.
type CheckedWrite = { steps: Step[] };

/**
 * Phase 1, outside Excel.run: parses and checks every write, and gives the steps of each one.
 * Nothing touches Excel yet.
 */
function parseAndCheckWrites(
  writes: WorkbookWrite[]
): Result<CheckedWrite[], string> {
  const checked: CheckedWrite[] = [];
  for (const [index, { expression }] of writes.entries()) {
    const steps = parseExpression(expression);
    if (steps.isErr()) {
      return new Err(`Write ${index}: invalid expression: ${steps.error}`);
    }
    const check = checkWriteSteps(steps.value);
    if (check.isErr()) {
      return new Err(`Write ${index}: ${check.error}`);
    }
    checked.push({ steps: steps.value });
  }
  return new Ok(checked);
}

/**
 * Phase 2, inside Excel.run: does the steps of every write, in the order of the input. The last
 * step of each expression is its write. Still one batch, nothing sent: an Office.js call only
 * adds a command to the queue of the context.
 */
function queueWrites(
  workbook: Excel.Workbook,
  checked: CheckedWrite[]
): Result<undefined, string> {
  for (const [index, { steps }] of checked.entries()) {
    const resolved = resolveSteps(workbook, steps);
    if (resolved.isErr()) {
      return new Err(`Write ${index}: ${resolved.error}`);
    }
  }
  return new Ok(undefined);
}

/**
 * A write that cannot be queued. `queueWrites` gives this error to `Excel.run` as a throw, not as
 * a return value: when the batch function returns, `Excel.run` calls `context.sync()` itself, which
 * would apply the writes queued before the one that failed. A throw stops the batch before that
 * sync, so nothing is applied.
 */
class QueueWritesError extends Error {}

export async function writeWorkbookTool({
  writes,
}: {
  writes: WorkbookWrite[];
}): Promise<ToolHandlerResult> {
  const checked = parseAndCheckWrites(writes);
  if (checked.isErr()) {
    return new Err(new MCPError(checked.error));
  }

  try {
    await Excel.run(async (context) => {
      const queued = queueWrites(context.workbook, checked.value);
      if (queued.isErr()) {
        throw new QueueWritesError(queued.error);
      }
      // Phase 3: one round trip to Excel does every write.
      await context.sync();
    });
    return new Ok([
      {
        type: "text",
        text: `Applied ${writes.length} write${pluralize(writes.length)} to the workbook.`,
      },
    ]);
  } catch (error) {
    if (error instanceof QueueWritesError) {
      // Nothing is applied: the throw stopped the batch before any sync.
      return new Err(new MCPError(error.message));
    }
    // Office.js rejects with an OfficeExtension.Error, e.g. `ItemNotFound` for an unknown sheet.
    // Its message is only the message of the host, such as "The requested resource doesn't
    // exist.", so `debugInfo` is added: it says which call failed. The writes before it in the
    // same call are applied, so the message asks the caller to read the workbook before it tries
    // again.
    // `debugInfo.statement` is the call that failed, with its arguments hidden, such as
    // `v1.getItem(...).getRange(...)`. `errorLocation` names the API, such as
    // `WorksheetCollection.getItem`. Both come from the host, so both can be missing.
    let location = "";
    if (error instanceof OfficeExtension.Error) {
      const where = error.debugInfo.statement ?? error.debugInfo.errorLocation;
      location = where ? ` (${error.code} on ${where})` : ` (${error.code})`;
    }
    return new Err(
      new MCPError(
        `Failed to write to the workbook: ${normalizeError(error).message}${location}. ` +
          "The writes before the one that failed are applied: read the workbook to see its " +
          "state before you try again."
      )
    );
  }
}
