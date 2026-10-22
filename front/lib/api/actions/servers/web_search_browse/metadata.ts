import type { ServerMetadata } from "@app/lib/actions/mcp_internal_actions/tool_definition";
import { z } from "zod";

const MAX_BROWSE_URLS = 16;

export const WEB_SEARCH_BROWSE_SERVER_NAME = "web_search_&_browse" as const;
export const WEB_SEARCH_BROWSE_ACTION_DESCRIPTION =
  "Agent can search (Google) and retrieve information from specific websites.";

export const WEB_SEARCH_BROWSE_TOOLS_METADATA = [
  {
    name: "websearch",
    description:
      "Search Google for web results, news, and current online information. " +
      "Look up any topic on the internet using a search query.",
    schema: {
      query: z
        .string()
        .describe(
          "The query used to perform the Google search. If requested by the " +
            "user, use the Google syntax `site:` to restrict the search " +
            "to a particular website or domain."
        ),
    },
    stake: "never_ask",
    enableAlerting: true,
    eager: true,
    displayLabels: {
      running: "Searching the web",
      done: "Web search",
    },
    toolCostCategory: "basic",
    freeUsage: false,
  },
  {
    name: "webbrowser",
    description:
      `Fetch and read the content of web pages and webpages from given URLs. ` +
      `Open and browse websites to extract text, or take a viewport or ` +
      `full-page screenshot. Accepts up to ${MAX_BROWSE_URLS} URLs at once.`,
    schema: {
      urls: z
        .string()
        .array()
        .max(MAX_BROWSE_URLS)
        .describe(`List of urls to browse (max: ${MAX_BROWSE_URLS})`),
      screenshotMode: z
        .enum(["none", "viewport", "fullPage"])
        .optional()
        .describe(
          "Screenshot mode: 'none' (default), 'viewport', or 'fullPage'."
        ),
      links: z
        .boolean()
        .optional()
        .describe("If true, also retrieve outgoing links from the page."),
    },
    stake: "never_ask",
    enableAlerting: true,
    eager: true,
    displayLabels: {
      running: "Browsing web page",
      done: "Browse web page",
    },
    toolCostCategory: "basic",
    freeUsage: false,
  },
] as const;

export const WEB_SEARCH_BROWSE_SERVER = {
  serverInfo: {
    name: WEB_SEARCH_BROWSE_SERVER_NAME,
    version: "1.0.0",
    description: WEB_SEARCH_BROWSE_ACTION_DESCRIPTION,
    authorization: null,
    icon: "ActionGlobeAltIcon" as const,
    documentationUrl: null,
  },
  tools: WEB_SEARCH_BROWSE_TOOLS_METADATA,
} as const satisfies ServerMetadata;
