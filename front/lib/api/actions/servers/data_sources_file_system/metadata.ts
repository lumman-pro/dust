import { ConfigurableToolInputSchemas } from "@app/lib/actions/mcp_internal_actions/input_schemas";
import type { ServerMetadata } from "@app/lib/actions/mcp_internal_actions/tool_definition";
import {
  SearchWithNodesInputSchema,
  TagsInputSchema,
} from "@app/lib/actions/mcp_internal_actions/types";
import {
  FIND_TAGS_BASE_DESCRIPTION,
  findTagsSchema,
} from "@app/lib/api/actions/tools/find_tags/metadata";
import { INTERNAL_MIME_TYPES } from "@dust-tt/client";
import { z } from "zod";

export const FIND_TAGS_TOOL_NAME = "find_tags";
export const FILESYSTEM_SEARCH_TOOL_NAME = "semantic_search";
export const FILESYSTEM_CAT_TOOL_NAME = "cat";
export const FILESYSTEM_FIND_TOOL_NAME = "find";
export const FILESYSTEM_LOCATE_IN_TREE_TOOL_NAME = "locate_in_tree";
export const FILESYSTEM_LIST_TOOL_NAME = "list";

export const DATA_SOURCES_FILE_SYSTEM_TOOLS_METADATA = [
  {
    name: FILESYSTEM_CAT_TOOL_NAME,
    description:
      "Read the full text content of a connected data source document or page by its nodeId (like 'cat' in Unix). " +
      `Use to open, view, or read a specific data source file after locating it via '${FILESYSTEM_FIND_TOOL_NAME}', '${FILESYSTEM_LIST_TOOL_NAME}', or '${FILESYSTEM_SEARCH_TOOL_NAME}'. ` +
      "The nodeId is the unique identifier exposed in the output of all navigation and search tools in this server. " +
      "The output reports the document's total size. For large documents, use 'grep' to extract only the relevant " +
      "content rather than paging through the whole document by incrementing 'offset', which exhausts the context window.",
    schema: {
      dataSources:
        ConfigurableToolInputSchemas[
          INTERNAL_MIME_TYPES.TOOL_INPUT.DATA_SOURCE
        ],
      nodeId: z
        .string()
        .describe(
          "The ID of the node to read. This is not the human-readable node title."
        ),
      offset: z
        .number()
        .optional()
        .describe(
          "The character position to start reading from (0-based). If not provided, starts from " +
            "the beginning. The tool output reports the total document size and, when more content " +
            "remains, the offset to use to continue reading."
        ),
      limit: z
        .number()
        .optional()
        .describe(
          "The maximum number of characters to read. If not provided, reads all characters. For " +
            "large documents, do not page through the whole document by repeatedly incrementing " +
            "offset (this exhausts the context window). Prefer grep to extract only the relevant content."
        ),
      grep: z
        .string()
        .optional()
        .describe(
          "A regular expression to filter lines. Applied after offset/limit slicing. Only lines " +
            "matching this pattern will be returned. Prefer this over reading a large document in " +
            "full when you are looking for specific content."
        ),
    },
    stake: "never_ask",
    displayLabels: {
      running: "Reading file from data source",
      done: "Read file from data source",
    },
    toolCostCategory: "advanced",
    freeUsage: false,
    enableAlerting: true,
  },
  {
    name: FILESYSTEM_LIST_TOOL_NAME,
    description:
      "Browse or explore the direct contents of a folder, section, or container node (like 'ls' in Unix). " +
      "Use to navigate the data source structure, see what documents or sub-folders are available, " +
      "or enumerate items inside a known location. Only works on nodes with children (hasChildren: true). " +
      "Call repeatedly with the 'nodeId' from each result to traverse nested folders step by step.",
    schema: {
      nodeId: z
        .string()
        .nullable()
        .describe(
          "The exact ID of the node to list the contents of. " +
            "This ID can be found from previous search results in the 'nodeId' field. " +
            "If not provided, the content at the root of the filesystem will be shown."
        ),
      mimeTypes: z
        .array(z.string())
        .optional()
        .describe(
          "The mime types to search for. If provided, only nodes with one of these mime types " +
            "will be returned. If not provided, no filter will be applied. The mime types passed " +
            "here must be one of the mime types found in the 'mimeType' field."
        ),
      dataSources:
        ConfigurableToolInputSchemas[
          INTERNAL_MIME_TYPES.TOOL_INPUT.DATA_SOURCE
        ],
      sortBy: z
        .enum(["title", "timestamp"])
        .optional()
        .describe(
          "Field to sort the results by. 'title' sorts alphabetically A-Z, 'timestamp' sorts by " +
            "most recent first. If not specified, results are returned in the default order, which is " +
            "folders first, then both documents and tables and alphabetically by title."
        ),
      limit: z
        .number()
        .optional()
        .describe(
          "Maximum number of results to return. Initial searches should use 10-20."
        ),
      nextPageCursor: z
        .string()
        .optional()
        .describe(
          "Cursor for fetching the next page of results. This parameter should only be used to fetch " +
            "the next page of a previous search. The value should be exactly the 'nextPageCursor' from " +
            "the previous search result."
        ),
    },
    stake: "never_ask",
    displayLabels: {
      running: "Listing data source contents",
      done: "List data source contents",
    },
    toolCostCategory: "advanced",
    freeUsage: false,
    enableAlerting: true,
  },
  {
    name: FILESYSTEM_SEARCH_TOOL_NAME,
    description:
      "Search semantically for information, documents, or content by topic, concept, or meaning within a connected data source. " +
      "Use to find relevant passages, answer questions, look up knowledge, or retrieve content from " +
      "connected data sources. Searches all children of the designated nodeIds. " +
      `Prefer this over '${FILESYSTEM_FIND_TOOL_NAME}' when you know what you're looking for conceptually but not the exact document title.`,
    schema: SearchWithNodesInputSchema.shape,
    stake: "never_ask",
    eager: true,
    displayLabels: {
      running: "Searching data sources",
      done: "Search data sources",
    },
    toolCostCategory: "advanced",
    freeUsage: false,
    enableAlerting: true,
  },
  {
    name: FILESYSTEM_FIND_TOOL_NAME,
    description:
      "Locate a document, page, or folder by searching its title (like 'find' in Unix). " +
      "Use to find a specific file or wiki page by name when you know (part of) its title — partial matches are supported. " +
      "Omit the query to enumerate all nodes under a given root. " +
      `Prefer '${FILESYSTEM_SEARCH_TOOL_NAME}' when looking for content by topic rather than by exact title.`,
    schema: {
      query: z
        .string()
        .optional()
        .describe(
          "The title to search for. This supports partial matching and does not require the " +
            "exact title. For example, searching for 'budget' will find 'Budget 2024.xlsx', " +
            "'Q1 Budget Report', etc..."
        ),
      rootNodeId: z
        .string()
        .optional()
        .describe(
          "The node ID of the node to start the search from. If not provided, the search will " +
            "start from the root of the filesystem. This ID can be found from previous search " +
            "results in the 'nodeId' field. This parameter restricts the search to the children " +
            "and descendant of a specific node. If a node output by this tool or the list tool" +
            "has children (hasChildren: true), it means that it can be passed as a rootNodeId."
        ),
      mimeTypes: z
        .array(z.string())
        .optional()
        .describe(
          "The mime types to search for. If provided, only nodes with one of these mime types " +
            "will be returned. If not provided, no filter will be applied. The mime types passed " +
            "here must be one of the mime types found in the 'mimeType' field."
        ),
      dataSources:
        ConfigurableToolInputSchemas[
          INTERNAL_MIME_TYPES.TOOL_INPUT.DATA_SOURCE
        ],
      limit: z
        .number()
        .optional()
        .describe(
          "Maximum number of results to return. Initial searches should use 10-20."
        ),
      nextPageCursor: z
        .string()
        .optional()
        .describe(
          "Cursor for fetching the next page of results. This parameter should only be used to fetch " +
            "the next page of a previous search. The value should be exactly the 'nextPageCursor' from " +
            "the previous search result."
        ),
    },
    stake: "never_ask",
    displayLabels: {
      running: "Finding in data sources",
      done: "Find in data sources",
    },
    toolCostCategory: "advanced",
    freeUsage: false,
    enableAlerting: true,
  },
  {
    name: FILESYSTEM_LOCATE_IN_TREE_TOOL_NAME,
    description:
      "Show the full breadcrumb path from a node back to the root of the data source (like 'pwd' in Unix). " +
      "Use to understand where a document lives in the folder hierarchy, navigate to parent sections, " +
      "or display the location of a search result. " +
      "Returns an ordered list of ancestor nodes from root to the target node.",
    schema: {
      nodeId: z.string().describe("The ID of the node to locate in the tree."),
      dataSources:
        ConfigurableToolInputSchemas[
          INTERNAL_MIME_TYPES.TOOL_INPUT.DATA_SOURCE
        ],
    },
    stake: "never_ask",
    displayLabels: {
      running: "Locating content in hierarchy",
      done: "Locate content in hierarchy",
    },
    toolCostCategory: "advanced",
    freeUsage: false,
    enableAlerting: true,
  },
] as const;

const [
  dataSourceFilesystemCatTool,
  dataSourceFilesystemListTool,
  dataSourceFilesystemSearchTool,
  dataSourceFilesystemFindTool,
  dataSourceFilesystemLocateInTreeTool,
] = DATA_SOURCES_FILE_SYSTEM_TOOLS_METADATA;

// Tool metadata with tags support for search and find tools
export const DATA_SOURCES_FILE_SYSTEM_TOOLS_WITH_TAGS_METADATA = [
  {
    ...dataSourceFilesystemCatTool,
    name: FILESYSTEM_CAT_TOOL_NAME,
  },
  {
    ...dataSourceFilesystemListTool,
    name: FILESYSTEM_LIST_TOOL_NAME,
  },
  {
    ...dataSourceFilesystemSearchTool,
    name: FILESYSTEM_SEARCH_TOOL_NAME,
    schema: {
      ...SearchWithNodesInputSchema.shape,
      ...TagsInputSchema.shape,
    },
  },
  {
    ...dataSourceFilesystemFindTool,
    name: FILESYSTEM_FIND_TOOL_NAME,
    schema: {
      ...dataSourceFilesystemFindTool.schema,
      ...TagsInputSchema.shape,
    },
  },
  {
    ...dataSourceFilesystemLocateInTreeTool,
    name: FILESYSTEM_LOCATE_IN_TREE_TOOL_NAME,
  },
  {
    name: FIND_TAGS_TOOL_NAME,
    description: FIND_TAGS_BASE_DESCRIPTION,
    schema: findTagsSchema,
    stake: "never_ask",
    displayLabels: {
      running: "Finding tags",
      done: "Find tags",
    },
    toolCostCategory: "advanced",
    freeUsage: false,
    enableAlerting: true,
  },
] as const;

export const DATA_SOURCES_FILE_SYSTEM_SERVER = {
  serverInfo: {
    name: "data_sources_file_system",
    version: "1.0.0",
    description: "Browse and search content with filesystem-like navigation.",
    authorization: null,
    icon: "ActionDocumentTextIcon",
    documentationUrl: null,
  },
  tools: DATA_SOURCES_FILE_SYSTEM_TOOLS_METADATA,
} as const satisfies ServerMetadata;
