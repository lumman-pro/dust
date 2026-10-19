import { MCPError } from "@app/lib/actions/mcp_errors";
import type { ToolHandlerResult } from "@app/lib/actions/mcp_internal_actions/tool_definition";
import { Err, Ok, type Result } from "@app/types/shared/result";
import { checkReadSteps } from "@extension/platforms/excel/tools/checkSteps";
import {
  parseExpression,
  type Step,
} from "@extension/platforms/excel/tools/parseExpression";
import { resolveSteps } from "@extension/platforms/excel/tools/resolveSteps";
import { normalizeError } from "@extension/shared/lib/utils";

type WorkbookRead = { expression: string };

// One read after the checks: the steps of its expression.
type CheckedRead = { steps: Step[] };

// An Office.js proxy object that can be loaded: every Office.js object (Range, Worksheet,
// collections...) extends `ClientObject`, and in Excel they all have `load` and `toJSON` —
// the base type just does not declare them, each subclass does.
type LoadableClientObject = OfficeExtension.ClientObject & {
  load: (properties: string[]) => void;
  toJSON: () => unknown;
};

// What an expression points to: an Office.js object that can be loaded (a Range, a Worksheet, a
// collection...), or a `ClientResult` from a method that gives a value directly (such as
// `getCount()`).
type ReadTarget = LoadableClientObject | OfficeExtension.ClientResult<unknown>;

function isLoadableClientObject(value: unknown): value is LoadableClientObject {
  return (
    value instanceof OfficeExtension.ClientObject &&
    "load" in value &&
    typeof value.load === "function" &&
    "toJSON" in value &&
    typeof value.toJSON === "function"
  );
}

function isReadTarget(value: unknown): value is ReadTarget {
  return (
    isLoadableClientObject(value) ||
    value instanceof OfficeExtension.ClientResult
  );
}

/**
 * Phase 1, outside Excel.run: parses and checks every read. Nothing touches Excel yet.
 */
function parseAndCheckReads(
  reads: WorkbookRead[]
): Result<CheckedRead[], string> {
  const checked: CheckedRead[] = [];
  for (const [index, { expression }] of reads.entries()) {
    const steps = parseExpression(expression);
    if (steps.isErr()) {
      return new Err(`Read ${index}: invalid expression: ${steps.error}`);
    }
    const check = checkReadSteps(steps.value);
    if (check.isErr()) {
      return new Err(`Read ${index}: ${check.error}`);
    }
    checked.push({ steps: steps.value });
  }
  return new Ok(checked);
}

/**
 * Does the steps of a read and gives what they point to, if it is a value that a read can
 * return.
 */
function resolveReadTarget(
  workbook: Excel.Workbook,
  steps: Step[]
): Result<ReadTarget, string> {
  const resolved = resolveSteps(workbook, steps);
  if (resolved.isErr()) {
    return resolved;
  }
  if (!isReadTarget(resolved.value)) {
    return new Err("the expression does not give an Office.js object.");
  }
  return new Ok(resolved.value);
}

/**
 * Phase 2, inside Excel.run: resolves the target of every read. The `load` step of each
 * expression queues its load. Still one batch, nothing sent. Returns one target per read, to give
 * to `readValue` after `context.sync()`.
 */
function queueReads(
  workbook: Excel.Workbook,
  checked: CheckedRead[]
): Result<ReadTarget[], string> {
  const queued: ReadTarget[] = [];
  for (const [index, { steps }] of checked.entries()) {
    const target = resolveReadTarget(workbook, steps);
    if (target.isErr()) {
      return new Err(`Read ${index}: ${target.error}`);
    }
    // An Office.js object is empty until it is loaded. A `ClientResult`, as from `getCount()`,
    // has nothing to load. `checkSteps` makes sure that `load` can only be the last step.
    // Example: `workbook.getSelectedRange()` gives this error.
    const lastStep = steps[steps.length - 1];
    if (
      target.value instanceof OfficeExtension.ClientObject &&
      lastStep?.name !== "load"
    ) {
      return new Err(
        `Read ${index}: end the expression with load(...), for example load(['address', 'values']).`
      );
    }
    queued.push(target.value);
  }
  return new Ok(queued);
}

/**
 * After `context.sync()`, gets the value of a read. Example: `{ values: [[...]] }` for
 * `getRange('A1:B2').load(['values'])`.
 */
function readValue(read: ReadTarget): unknown {
  return read instanceof OfficeExtension.ClientResult
    ? read.value
    : read.toJSON();
}

export async function readWorkbookTool({
  reads,
}: {
  reads: WorkbookRead[];
}): Promise<ToolHandlerResult> {
  const checked = parseAndCheckReads(reads);
  if (checked.isErr()) {
    return new Err(new MCPError(checked.error));
  }

  try {
    const result = await Excel.run(async (context) => {
      const queued = queueReads(context.workbook, checked.value);
      if (queued.isErr()) {
        return new Err(queued.error);
      }
      // Phase 3: one round trip to Excel fills everything, then `readValue` gets the values.
      await context.sync();
      return new Ok(JSON.stringify(queued.value.map(readValue)));
    });
    if (result.isErr()) {
      return new Err(new MCPError(result.error));
    }
    return new Ok([{ type: "text", text: result.value }]);
  } catch (error) {
    // Office.js rejects with an OfficeExtension.Error, e.g. `ItemNotFound` for an unknown sheet.
    return new Err(
      new MCPError(
        `Failed to read the workbook: ${normalizeError(error).message}`
      )
    );
  }
}
