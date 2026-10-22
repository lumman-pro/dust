import { Ok, type Result } from "@app/types/shared/result";
import type { ExcelArg } from "@extension/platforms/excel/tools/parseExpression";

/**
 * Checks every formula that an argument of a write carries.
 *
 * TODO(office_addin): refuse a formula that calls a function which reaches outside the workbook,
 * such as `WEBSERVICE` or `IMAGE`, or a custom function of an add-in. Until then a write carries
 * any formula.
 */
export function checkFormulasInArgument(
  arg: ExcelArg
): Result<undefined, string> {
  return new Ok(undefined);
}
