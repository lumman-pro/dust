import { ConfigurableToolInputSchemas } from "@app/lib/actions/mcp_internal_actions/input_schemas";
import { INTERNAL_MIME_TYPES } from "@dust-tt/client";
import { z } from "zod";

const SearchInputSchema = z.object({
  query: z
    .string()
    .describe(
      "The string used to retrieve relevant chunks of information using semantic similarity" +
        " based on the user request and conversation context." +
        " Include as much semantic signal based on the entire conversation history," +
        " paraphrasing if necessary. longer queries are generally better."
    ),
  relativeTimeFrame: z
    .string()
    .regex(/^(all|\d+[hdwmy])$/)
    .describe(
      "The time frame (relative to LOCAL_TIME) to restrict the search based" +
        " on the user request and past conversation context." +
        " Possible values are: `all`, `{k}h`, `{k}d`, `{k}w`, `{k}m`, `{k}y`" +
        " where {k} is a number. Be strict, do not invent invalid values."
    )
    .optional(),
});

export type SearchInputType = z.infer<typeof SearchInputSchema>;

export const SearchWithDataSourcesInputSchema = SearchInputSchema.extend({
  dataSources:
    ConfigurableToolInputSchemas[INTERNAL_MIME_TYPES.TOOL_INPUT.DATA_SOURCE],
});

export const SearchWithNodesInputSchema =
  SearchWithDataSourcesInputSchema.extend({
    nodeIds: z
      .array(z.string())
      .describe(
        "Array of exact content node IDs to search within. These are the 'nodeId' values from " +
          "previous search results. All children of the designated nodes will be searched. " +
          "If not provided, all available nodes will be searched."
      )
      .optional(),
  });

export type SearchWithNodesInputType = z.infer<
  typeof SearchWithNodesInputSchema
>;

export const TagsInputSchema = z.object({
  tagsIn: z
    .array(z.string())
    .optional()
    .describe(
      "A list of labels (also called tags) to restrict the search based on the user request and past conversation context." +
        "If multiple labels are provided, the search will return documents that have at least one of the labels." +
        "You can't check that all labels are present, only that at least one is present." +
        "If no labels are provided, the search will return all documents regardless of their labels."
    ),
  tagsNot: z
    .array(z.string())
    .optional()
    .describe(
      "A list of labels (also called tags) to exclude from the search based on the user request and past conversation context." +
        "Any document having one of these labels will be excluded from the search."
    ),
});

export type TagsInputType = z.infer<typeof TagsInputSchema>;

export type SearchInputTypeWithTags = SearchInputType & TagsInputType;

export function isSearchInputTypeWithTags(
  input: Record<string, unknown>
): input is SearchInputTypeWithTags {
  return (
    SearchInputSchema.safeParse(input).success ||
    SearchWithNodesInputSchema.extend(TagsInputSchema.shape).safeParse(input)
      .success
  );
}

export const IncludeInputSchema = z.object({
  timeFrame:
    ConfigurableToolInputSchemas[
      INTERNAL_MIME_TYPES.TOOL_INPUT.TIME_FRAME
    ].optional(),
  dataSources:
    ConfigurableToolInputSchemas[INTERNAL_MIME_TYPES.TOOL_INPUT.DATA_SOURCE],
});

export type IncludeInputType = z.infer<typeof IncludeInputSchema>;

export function isIncludeInputType(
  input: Record<string, unknown>
): input is IncludeInputType {
  return (
    IncludeInputSchema.safeParse(input).success ||
    IncludeInputSchema.extend(TagsInputSchema.shape).safeParse(input).success
  );
}

export const GenerateImageInputSchema = z.object({
  prompt: z
    .string()
    .max(4000)
    .describe("A text description of the desired image."),
  outputName: z
    .string()
    .max(64)
    .describe(
      "The filename that will be used to save the generated image. Must be 64 characters or less."
    ),
  referenceImages: z
    .array(z.string())
    .max(14)
    .optional()
    .describe(
      "Optional file IDs of reference images from conversation attachments.\n" +
        "- For object inclusion: up to 6 images to reproduce objects with high fidelity\n" +
        "- For human consistency: up to 5 images to maintain character appearance\n" +
        "- Maximum 14 total reference images can be combined\n" +
        "- Supported formats: PNG, JPEG, WebP, HEIC, HEIF\n\n"
    ),
  aspectRatio: z
    .enum([
      "1:1",
      "3:2",
      "2:3",
      "3:4",
      "4:3",
      "4:5",
      "5:4",
      "9:16",
      "16:9",
      "21:9",
    ])
    .optional()
    .default("1:1")
    .describe(
      "The aspect ratio of the generated image. Must be one of 1:1, 3:2, 2:3, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, or 21:9."
    ),
  // Display/parse path for stored actions. Kept permissive (still accepts the
  // legacy "high"/4K tier) so historical conversations render correctly. The
  // agent-facing write path is capped at "medium" in image_generation/metadata.ts.
  quality: z
    .enum(["low", "medium", "high"])
    .optional()
    .default("low")
    .describe(
      "Output resolution: low (1K/1024px), medium (2K/2048px), or high (4K/4096px)."
    ),
});

export type GenerateImageInputType = z.infer<typeof GenerateImageInputSchema>;

export function isGenerateImageInputType(
  input: Record<string, unknown>
): input is GenerateImageInputType {
  return GenerateImageInputSchema.safeParse(input).success;
}
