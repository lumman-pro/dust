import { Err, Ok, type Result } from "@app/types/shared/result";
import { assertNever } from "@app/types/shared/utils/assert_never";
import { checkFormulasInValue } from "@extension/platforms/excel/tools/formulas";
import type {
  Argument,
  Step,
} from "@extension/platforms/excel/tools/parseExpression";

// The member names of all the Excel classes. Example: "getRange" is in this type.
//   1. `keyof typeof Excel` gives each name in the `Excel` namespace. Example: "Range".
//   2. `infer Instance` keeps only the classes. For "Range", `Instance` is `Excel.Range`.
//   3. `keyof Instance` gives the member names of the class. Example: "getCell".
//   4. `[keyof typeof Excel]` puts the names of all the classes in one union.
type ExcelMember = {
  [Name in keyof typeof Excel]: (typeof Excel)[Name] extends abstract new (
    ...args: never[]
  ) => infer Instance
    ? keyof Instance
    : never;
}[keyof typeof Excel];

// The methods that an expression can call, other than `load`. Each one only reads. These are the
// `get*` methods of the Office.js Excel API, and the `find*` and `isFiltered` methods.
//
// The add-in loads the latest Office.js from the Microsoft CDN, so new methods can come without a
// release of the add-in.
//
// These methods only read, but they are not in the list:
//   - `evaluate`: a formula such as `WEBSERVICE("https://...")` can send data out.
//   - `getImage` and `getAsImage`: TODO(office_addin): allow them. The tool returns only text, and
//     the model sees a base64 string in text as characters, not as an image. To allow them, return
//     each image as an `image` content block.
const READ_METHODS: ReadonlySet<string> = new Set<ExcelMember>([
  "getAbsoluteResizedRange",
  "getActive",
  "getActiveCell",
  "getActiveChart",
  "getActiveChartOrNullObject",
  "getActiveShape",
  "getActiveShapeOrNullObject",
  "getActiveSlicer",
  "getActiveSlicerOrNullObject",
  "getActiveWorksheet",
  "getBoundingRect",
  "getByNamespace",
  "getCell",
  "getCellAfterBreak",
  "getCellProperties",
  "getColumn",
  "getColumnLabelRange",
  "getColumnProperties",
  "getColumnsAfter",
  "getColumnsBefore",
  "getCount",
  "getDataBodyRange",
  "getDataHierarchy",
  "getDataSourceString",
  "getDataSourceType",
  "getDataTable",
  "getDataTableOrNullObject",
  "getDefault",
  "getDependents",
  "getDimensionDataSourceString",
  "getDimensionDataSourceType",
  "getDimensionValues",
  "getDirectDependents",
  "getDirectPrecedents",
  "getDisplayedCellProperties",
  "getEntireColumn",
  "getEntireRow",
  "getExtendedRange",
  "getFilterAxisRange",
  "getFilters",
  "getFirst",
  "getFirstOrNullObject",
  "getHeaderRowRange",
  "getIntersection",
  "getIntersectionOrNullObject",
  "getInvalidCells",
  "getInvalidCellsOrNullObject",
  "getIsActiveCollabSession",
  "getItem",
  "getItemAt",
  "getItemByCell",
  "getItemByName",
  "getItemByNameOrNullObject",
  "getItemByReplyId",
  "getItemOrNullObject",
  "getLast",
  "getLastCell",
  "getLastColumn",
  "getLastRow",
  "getLinkedEntityCellValue",
  "getLocation",
  "getLocationOrNullObject",
  "getMergedAreasOrNullObject",
  "getNext",
  "getNextOrNullObject",
  "getOffsetRange",
  "getOffsetRangeAreas",
  "getOnlyItem",
  "getOnlyItemOrNullObject",
  "getParentComment",
  "getPivotItems",
  "getPivotTables",
  "getPrecedents",
  "getPrevious",
  "getPreviousOrNullObject",
  "getPrintArea",
  "getPrintAreaOrNullObject",
  "getPrintTitleColumns",
  "getPrintTitleColumnsOrNullObject",
  "getPrintTitleRows",
  "getPrintTitleRowsOrNullObject",
  "getRange",
  "getRangeAreasBySheet",
  "getRangeAreasOrNullObjectBySheet",
  "getRangeByIndexes",
  "getRangeEdge",
  "getRangeOrNullObject",
  "getRanges",
  "getResizedRange",
  "getRow",
  "getRowLabelRange",
  "getRowProperties",
  "getRowsAbove",
  "getRowsBelow",
  "getSelectedItems",
  "getSelectedRange",
  "getSelectedRanges",
  "getSolidColor",
  "getSpecialCells",
  "getSpecialCellsOrNullObject",
  "getSpillParent",
  "getSpillParentOrNullObject",
  "getSpillingToRange",
  "getSpillingToRangeOrNullObject",
  "getSubstring",
  "getSurroundingRegion",
  "getTable",
  "getTables",
  "getTailAnchor",
  "getText",
  "getTotalRowRange",
  "getUsedRange",
  "getUsedRangeAreas",
  "getUsedRangeAreasOrNullObject",
  "getUsedRangeOrNullObject",
  "getVisibleView",
  "find",
  "findOrNullObject",
  "findAll",
  "findAllOrNullObject",
  "isFiltered",
]);

// The methods that a write expression can call as its last step. Each one changes the workbook,
// the way the user would from the Excel window: it adds, changes, sorts or removes content.
//
// `set` is the method that changes the properties of an object. Every Office.js object has it,
// and it takes the properties as one object: `range.set({ values: [[1]] })` writes what
// `range.values = [[1]]` would write. It is why an expression never assigns.
//
// A method that is not in this list is refused, even when it writes. To allow one, add it here.
//
// `insertWorksheetsFromBase64` is not in the list on purpose: it inserts the worksheets of
// another workbook, given as a base64 string. Their cells carry their own formulas, which stay
// inside that string, so `checkFormulasInValue` never reads them. It is a way around the only
// rule that stops a formula from reaching outside the workbook.
const WRITE_METHODS: ReadonlySet<string> = new Set<ExcelMember>([
  "set",
  "activate",
  "add",
  "adjustIndent",
  "apply",
  "applyBottomItemsFilter",
  "applyBottomPercentFilter",
  "applyCellColorFilter",
  "applyCustomFilter",
  "applyDynamicFilter",
  "applyFilter",
  "applyFontColorFilter",
  "applyIconFilter",
  "applyTopItemsFilter",
  "applyTopPercentFilter",
  "applyValuesFilter",
  "autoFill",
  "autofitColumns",
  "autofitRows",
  "calculate",
  "changeRuleToCellValue",
  "changeRuleToColorScale",
  "changeRuleToContainsText",
  "changeRuleToCustom",
  "changeRuleToDataBar",
  "changeRuleToIconSet",
  "changeRuleToPresetCriteria",
  "changeRuleToTopBottom",
  "clear",
  "clearAll",
  "clearAllFilters",
  "clearColumnCriteria",
  "clearCriteria",
  "clearFilter",
  "clearFilters",
  "clearFormat",
  "clearOrResetContents",
  "convertDataTypeToText",
  "convertToRange",
  "copy",
  "copyFrom",
  "delete",
  "displayBlankLineAfterEachItem",
  "duplicate",
  "flashFill",
  "freezeAt",
  "freezeColumns",
  "freezeRows",
  "group",
  "hideGroupDetails",
  "insert",
  "merge",
  "moveTo",
  "reapply",
  "reapplyFilters",
  "refresh",
  "refreshAll",
  "remove",
  "removeDuplicates",
  "repeatAllItemLabels",
  "replaceAll",
  "resize",
  "select",
  "selectItems",
  "setAutoSortOnCell",
  "setBubbleSizes",
  "setCategoryNames",
  "setCellProperties",
  "setColumnProperties",
  "setCustomDisplayUnit",
  "setData",
  "setDefault",
  "setDirty",
  "setFormula",
  "setHeight",
  "setPosition",
  "setPositionAt",
  "setPrintArea",
  "setPrintMargins",
  "setPrintTitleColumns",
  "setPrintTitleRows",
  "setRanges",
  "setRowProperties",
  "setSolidColor",
  "setToDefault",
  "setValues",
  "setWidth",
  "setXAxisValues",
  "showGroupDetails",
  "showOutlineLevels",
  "sortByLabels",
  "sortByValues",
  "unfreeze",
  "ungroup",
  "unmerge",
]);

/**
 * Checks the `load` step.
 *
 * The properties in `load` are not checked: a load only reads, and Office.js gives an error for a
 * property that it does not know.
 *
 * Examples:
 *   - `workbook.worksheets.load('name').getItem('Sheet1')` is not allowed: `load` is not the last
 *     step.
 *   - `workbook.getSelectedRange().load()` is not allowed: it loads all the properties, which can
 *     be very large.
 */
function checkLoadStep(
  step: Step,
  isLastStep: boolean
): Result<undefined, string> {
  if (!isLastStep) {
    return new Err('"load" must be the last step of the expression.');
  }
  if (step.kind !== "call" || step.args.length !== 1) {
    return new Err(
      "\"load\" needs one argument, for example load(['address', 'values'])."
    );
  }
  return new Ok(undefined);
}

/**
 * Says if a name is not part of the Office.js API. A property is always allowed, so these names
 * are refused:
 *   - `workbook.constructor` gives the `Workbook` class, not a workbook.
 *     `workbook.constructor.constructor` gives `Function`, which turns a string into code.
 *   - `workbook.__proto__` gives the object that holds the methods of all workbooks.
 *   - `workbook._context` and the other names that start with `_` are internal data of
 *     Office.js.
 */
function isInternalName(name: string): boolean {
  return name.startsWith("_") || name === "constructor";
}

/**
 * Checks the paths that the arguments of a call carry. A path gives an Office.js object to the
 * method, as in `charts.add('ColumnClustered', workbook...getRange('A1:B10'))`.
 *
 * A path only moves to an object. So every step of a path must pass the check of a read step.
 */
function checkPathSteps(steps: Step[]): Result<undefined, string> {
  for (const step of steps) {
    const check = checkReadStep(step, false);
    if (check.isErr()) {
      return check;
    }
  }
  return new Ok(undefined);
}

/**
 * Checks the paths that the arguments of a read carry. A literal holds no step.
 */
function checkPathArguments(args: Argument[]): Result<undefined, string> {
  for (const arg of args) {
    switch (arg.kind) {
      case "literal":
        break;
      case "path": {
        const check = checkPathSteps(arg.steps);
        if (check.isErr()) {
          return check;
        }
        break;
      }
      default:
        assertNever(arg);
    }
  }
  return new Ok(undefined);
}

/**
 * Checks a step that only reads: every step of a read, and every step of a write before the one
 * that writes.
 *
 * Examples:
 *   - The property `worksheets` is allowed: to get a property only reads.
 *   - The call `getItem('Sheet1')` is allowed: `getItem` is in `READ_METHODS`.
 *   - The call `delete()` is not allowed: it is not in `READ_METHODS`.
 */
function checkReadStep(
  step: Step,
  isLastStep: boolean
): Result<undefined, string> {
  if (isInternalName(step.name)) {
    return new Err(`"${step.name}" is not allowed.`);
  }
  if (step.name === "load") {
    return checkLoadStep(step, isLastStep);
  }
  switch (step.kind) {
    case "property":
      return new Ok(undefined);
    case "call":
      if (!READ_METHODS.has(step.name)) {
        return new Err(
          `"${step.name}" is not allowed: only read methods are allowed.`
        );
      }
      return checkPathArguments(step.args);
  }
}

/**
 * Checks the steps of a read expression. A property is always allowed, and a method call only if
 * the method only reads.
 *
 * Example: `workbook.worksheets.getItem('Sheet1').load('name')` is allowed. Each step is checked:
 * the property `worksheets`, the call `getItem('Sheet1')`, then the call `load('name')`.
 *
 * This check does not know what each step gives. Thus `queueReads` checks, in Excel.run, that an
 * expression that gives an Office.js object ends with `load(...)`.
 */
export function checkReadSteps(steps: Step[]): Result<undefined, string> {
  for (const [index, step] of steps.entries()) {
    const check = checkReadStep(step, index === steps.length - 1);
    if (check.isErr()) {
      return check;
    }
  }
  return new Ok(undefined);
}

/**
 * Checks the step that writes, which is the last step of a write expression.
 *
 * Examples:
 *   - `add('Sheet2')` is allowed: `add` is in `WRITE_METHODS`.
 *   - `set({ values: [[1]] })` is allowed, and its properties are checked for formulas.
 */
function checkWriteStep(step: Step): Result<undefined, string> {
  if (isInternalName(step.name)) {
    return new Err(`"${step.name}" is not allowed.`);
  }
  if (step.kind !== "call" || !WRITE_METHODS.has(step.name)) {
    return new Err(
      `"${step.name}" is not allowed: a write must end with a method that changes the workbook, such as "set".`
    );
  }
  // This step is the only one that writes, so its arguments are the only ones that put a
  // formula in the workbook: the properties of `set`, the reference of `names.add`, the rule of
  // a conditional format. The steps before it only read.
  for (const arg of step.args) {
    switch (arg.kind) {
      // A literal can hold a formula, and this step is the one that writes it.
      case "literal": {
        const check = checkFormulasInValue(arg.value);
        if (check.isErr()) {
          return check;
        }
        break;
      }
      // A path gives an Office.js object to the method, and it must only read.
      case "path": {
        const check = checkPathSteps(arg.steps);
        if (check.isErr()) {
          return check;
        }
        break;
      }
      default:
        assertNever(arg);
    }
  }
  return new Ok(undefined);
}

/**
 * Checks the steps of a write expression: every step before the last one only moves to another
 * object, and the last one is the write.
 *
 * Examples:
 *   - `workbook.worksheets.add('Sheet2')` is allowed: `add` is in `WRITE_METHODS`.
 *   - `workbook.worksheets.getItem('Sheet1').getRange('A1').set({ values: [[1]] })` is allowed:
 *     the steps before `set` only move to the range.
 */
export function checkWriteSteps(steps: Step[]): Result<undefined, string> {
  const lastStep = steps[steps.length - 1];
  if (!lastStep) {
    return new Err("the expression must write something.");
  }
  // Every step before the last one only moves to another object, which is what a read does.
  for (const step of steps.slice(0, -1)) {
    const check = checkReadStep(step, false);
    if (check.isErr()) {
      return check;
    }
  }
  return checkWriteStep(lastStep);
}
