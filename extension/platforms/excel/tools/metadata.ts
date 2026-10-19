import type { ToolMeta } from "@app/lib/actions/mcp_internal_actions/tool_definition";
import { z } from "zod";

export const READ_WORKBOOK_TOOL_NAME = "read_workbook";
export const WRITE_WORKBOOK_TOOL_NAME = "write_workbook";

const MAX_EXPRESSION_LENGTH = 1_000;

const READ_WORKBOOK_TOOL_DESCRIPTION = `Reads data from the Excel workbook that the user has open.

Each read is an Office.js Excel expression that starts with \`workbook\`. End the expression with \`load(...)\` to give the properties to return. Do not add \`load(...)\` after a method that gives a value, for example \`getCount()\`. The result has one item for each read, in the same order.

Example:
{ "reads": [
  { "expression": "workbook.worksheets.load('name')" },
  { "expression": "workbook.worksheets.getItem('Sheet1').getRange('A1:C10').load(['address', 'values', 'format/fill/color'])" },
  { "expression": "workbook.tables.getCount()" }
] }`;

const readSchema = z.object({
  expression: z
    .string()
    .max(MAX_EXPRESSION_LENGTH)
    .describe(
      "An Office.js Excel expression that starts with `workbook`. Use only properties and method calls with literal arguments. Do not use `context`, `await` or `sync()`."
    ),
});

const MAX_READS = 50;

const WRITE_WORKBOOK_TOOL_DESCRIPTION = `Writes to the Excel workbook that the user has open.

Each write is an Office.js Excel expression that starts with \`workbook\` and ends with a method that changes the workbook, as in \`... .insert('Down')\`. To change the properties of an object, call \`set(...)\` with the properties as one object, as in \`... .set({ values: [[1, 2]] })\`. An assignment with \`=\` is not allowed. The arguments must be written in the expression: no variable, no computation.

To write a large table, use several writes, one for a group of rows: about 20 rows of 4 columns fit in one expression.

The writes run in the order given, in one sync. A write that fails stops the call, and the writes after it do not run.

Use ${READ_WORKBOOK_TOOL_NAME} to see the sheets, the used range and the current content before a write, and to check the result after it.

Example:
{ "writes": [
  { "expression": "workbook.worksheets.add('Report')" },
  { "expression": "workbook.worksheets.getItem('Report').getRange('A1:B2').set({ values: [['Month', 'Total'], ['January', 120]] })" },
  { "expression": "workbook.worksheets.getItem('Report').getRange('A1:B1').set({ format: { font: { bold: true } } })" },
  { "expression": "workbook.worksheets.getItem('Report').getRange('A1:B2').format.autofitColumns()" }
] }`;

const writeSchema = z.object({
  expression: z
    .string()
    .max(MAX_EXPRESSION_LENGTH)
    .describe(
      "An Office.js Excel expression that starts with `workbook` and ends with a method that changes the workbook, such as `set({ values: [[1]] })`. Use only properties and method calls with literal arguments. Do not use `context`, `await` or `sync()`."
    ),
});

const MAX_WRITES = 50;

export const EXCEL_TOOLS_METADATA = [
  {
    name: READ_WORKBOOK_TOOL_NAME,
    description: READ_WORKBOOK_TOOL_DESCRIPTION,
    schema: {
      reads: z
        .array(readSchema)
        .min(1)
        .max(MAX_READS)
        .describe(
          "The reads to run. They are sent to Excel together, in one sync."
        ),
    },
    stake: "never_ask",
    displayLabels: {
      running: "Reading the workbook...",
      done: "Workbook read",
    },
    toolCostCategory: "basic",
    freeUsage: true,
  },
  {
    name: WRITE_WORKBOOK_TOOL_NAME,
    description: WRITE_WORKBOOK_TOOL_DESCRIPTION,
    schema: {
      writes: z
        .array(writeSchema)
        .min(1)
        .max(MAX_WRITES)
        .describe(
          "The writes to run. They are sent to Excel together, in one sync, in this order."
        ),
    },
    stake: "medium",
    displayLabels: {
      running: "Writing to the workbook...",
      done: "Workbook updated",
    },
    toolCostCategory: "basic",
    freeUsage: true,
  },
] as const satisfies readonly ToolMeta[];
