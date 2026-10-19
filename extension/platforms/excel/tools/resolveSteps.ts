import { Err, Ok, type Result } from "@app/types/shared/result";
import { assertNever } from "@app/types/shared/utils/assert_never";
import type { Step } from "@extension/platforms/excel/tools/parseExpression";

/**
 * Gets the value that the steps point to. It starts at the workbook and does one step at a time.
 *
 * Example. `parseExpression` turns `workbook.worksheets.getItem('Sheet1')` into these steps:
 *   1. `{ kind: "property", name: "worksheets" }`
 *   2. `{ kind: "call", name: "getItem", args: ["Sheet1"] }`
 * This function then does:
 *   - At the start, `current` is the workbook.
 *   - Step 1 gets the property `worksheets` of the workbook. `current` is the worksheet collection.
 *   - Step 2 calls `getItem("Sheet1")` on the collection. `current` is the worksheet `Sheet1`.
 *
 * Why the tools do not run the text of the expression:
 * For an allowed expression, the result is the same. But to run the text, the JavaScript engine
 * must parse it again, and the check was done on the parse of `parseExpression`. If the two
 * parses do not agree on an input, code that the check did not see can run. Here, the tools run
 * only the steps, which are the data that the check accepted. Thus, no other code can run.
 *
 * Nothing goes to Excel here. An Office.js call only adds a command to a queue, and
 * `context.sync()` sends the queue later.
 *
 * `Reflect.get` and `Reflect.apply` can give any value, so the result is `unknown`. The caller
 * checks that it is the kind of value that it needs. The loop checks that each step starts from
 * an Office.js object.
 */
export function resolveSteps(
  workbook: Excel.Workbook,
  steps: Step[]
): Result<unknown, string> {
  let current: unknown = workbook;
  for (const step of steps) {
    // Each step must start from an Office.js object. `checkStep` already refuses `constructor`,
    // so `workbook.constructor.constructor('code')` cannot reach `Function`. This check is a
    // second protection: a step cannot run on a JavaScript function or another value that a
    // property gives, such as `workbook.context`. Also, `Reflect.get` needs an object.
    if (!(current instanceof OfficeExtension.ClientObject)) {
      return new Err(
        `cannot get "${step.name}" on a value that is not an Office.js object.`
      );
    }
    // Gets the member by its name: the property to return (`worksheets`), or the method to call
    // (`getItem`). `Reflect.get(workbook, "worksheets")` is `workbook.worksheets`.
    const member: unknown = Reflect.get(current, step.name);
    switch (step.kind) {
      case "property":
        current = member;
        break;
      case "call":
        if (typeof member !== "function") {
          return new Err(`"${step.name}" is not a method.`);
        }
        // `Reflect.apply(getItem, worksheets, ["Sheet1"])` is `worksheets.getItem("Sheet1")`.
        // The second argument is the object that the method runs on.
        current = Reflect.apply(member, current, step.args);
        break;
      default:
        assertNever(step);
    }
  }
  return new Ok(current);
}
