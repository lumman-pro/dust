import { safeParseJSON } from "@app/types/shared/utils/json_utils";
import escape from "lodash/escape";
import unescape from "lodash/unescape";
import { z } from "zod";

export const FRAME_EMBED_DIRECTIVE_NAME = "embed_frame";
export const FRAME_EMBED_COMPONENT_NAME = "frame_embed";

export type FrameEmbedProps = Record<string, string>;

const ESCAPED_ATTRIBUTE_CHARACTER = String.raw`(?:[^"&<>'\r\n]|&(?:amp|lt|gt|quot|#39);)`;

const FRAME_EMBED_ATTRIBUTE_NAME = "[A-Za-z][A-Za-z0-9_]*";

// Front cannot import viz, so a test pins these to viz's `FRAME_PROP_NAME_REGEX` and
// `REACT_RESERVED_PROP_NAMES`.
export const FRAME_EMBED_PROP_NAME_REGEX = new RegExp(
  `^${FRAME_EMBED_ATTRIBUTE_NAME}$`
);

export const REACT_RESERVED_PROP_NAMES = new Set(["key", "ref"]);

const FRAME_EMBED_RESERVED_ATTRIBUTES = new Set([
  "path",
  "height",
  ...REACT_RESERVED_PROP_NAMES,
]);

const FRAME_EMBED_ATTRIBUTE_SOURCE = String.raw`${FRAME_EMBED_ATTRIBUTE_NAME}="${ESCAPED_ATTRIBUTE_CHARACTER}*"`;

const FRAME_EMBED_DIRECTIVE_REGEX = new RegExp(
  String.raw`^::${FRAME_EMBED_DIRECTIVE_NAME}\{(${FRAME_EMBED_ATTRIBUTE_SOURCE}(?: ${FRAME_EMBED_ATTRIBUTE_SOURCE})*)\}[ \t]*(?:\n|$)`
);

const FRAME_EMBED_ATTRIBUTE_REGEX = new RegExp(
  String.raw`(${FRAME_EMBED_ATTRIBUTE_NAME})="(${ESCAPED_ATTRIBUTE_CHARACTER}*)"`,
  "g"
);

const FRAME_EMBED_HEIGHT_REGEX = /^[1-9]\d{0,4}$/;

const MAX_FRAME_EMBED_HEIGHT_PX = 99999;

const FRAME_EMBED_DIRECTIVE_START_REGEX = new RegExp(
  String.raw`\n::${FRAME_EMBED_DIRECTIVE_NAME}\{`
);

// marked looks for the block that interrupts a paragraph in the paragraph's source after its first
// character, so the start of `src` is not the start of a line.
/** Index of the first line of `src` after its first that may open a frame embed, or -1. */
export function findFrameEmbedDirective(src: string): number {
  const index = src.search(FRAME_EMBED_DIRECTIVE_START_REGEX);
  return index === -1 ? -1 : index + 1;
}

function parseFrameEmbedAttributes(source: string): {
  path: string;
  height: number | null;
  props: FrameEmbedProps;
} | null {
  const names = new Set<string>();
  let path: string | null = null;
  let height: number | null = null;
  const props: FrameEmbedProps = {};
  for (const [, name, value] of source.matchAll(FRAME_EMBED_ATTRIBUTE_REGEX)) {
    if (names.has(name) || REACT_RESERVED_PROP_NAMES.has(name)) {
      return null;
    }
    names.add(name);
    if (name === "path") {
      if (value.length === 0) {
        return null;
      }
      path = unescape(value);
    } else if (name === "height") {
      if (!FRAME_EMBED_HEIGHT_REGEX.test(value)) {
        return null;
      }
      height = Number(value);
    } else {
      props[name] = unescape(value);
    }
  }
  return path === null ? null : { path, height, props };
}

/**
 * @cc [owner:tdraier,label:product] frame-embed-directive
 * A frame embed MUST be read only from a line holding exactly `::embed_frame{…}`, trailing spaces
 * aside, whose braces hold one or more ` `-separated `<name>="<value>"` attributes in any order,
 * each name at most once: a `path`, HTML-escaped and non-empty, an optional `height` in plain
 * digits that `parseFrameEmbedHeight` accepts, and props, each a name of a letter then letters,
 * digits or `_`, other than React's `key` and `ref`, with an HTML-escaped value; anything else MUST
 * NOT parse, so a writer never drops what the directive does not define. HTML-escaped means each
 * `&`, `<`, `>`, `"` and `'` written as `&amp;`, `&lt;`, `&gt;`, `&quot;` and `&#39;`, the only
 * entities read. `serializeFrameEmbedDirective` MUST write a line this function reads back to the
 * same path, height and props, in order, for any path `isFrameEmbedPath`, height
 * `parseFrameEmbedHeight` and props `parseFrameEmbedProps` accept. The directive name MUST keep a `_`, which the editor writes escaped in text, so text
 * that reads as the directive saves as `::embed\_frame` and reopens as text.
 */
export function parseFrameEmbedDirective(src: string): {
  path: string;
  height: number | null;
  props: FrameEmbedProps;
  raw: string;
} | null {
  const match = src.match(FRAME_EMBED_DIRECTIVE_REGEX);
  if (!match) {
    return null;
  }
  const attributes = parseFrameEmbedAttributes(match[1]);
  return attributes ? { ...attributes, raw: match[0] } : null;
}

export function serializeFrameEmbedDirective(
  path: string,
  height: number | null = null,
  props: FrameEmbedProps = {}
): string {
  const propsSource = Object.entries(props)
    .map(([name, value]) => ` ${name}="${escape(value)}"`)
    .join("");
  return `::${FRAME_EMBED_DIRECTIVE_NAME}{path="${escape(path)}"${
    height !== null ? ` height="${height}"` : ""
  }${propsSource}}`;
}

/** A height the directive can hold, in pixels, or null. */
export function parseFrameEmbedHeight(value: unknown): number | null {
  const height = typeof value === "number" ? value : Number(value);
  return Number.isInteger(height) &&
    height > 0 &&
    height <= MAX_FRAME_EMBED_HEIGHT_PX
    ? height
    : null;
}

export function isFrameEmbedPath(path: string): boolean {
  return path.length > 0 && !/[\r\n]/.test(path);
}

function isFrameEmbedPropName(name: string): boolean {
  return (
    FRAME_EMBED_PROP_NAME_REGEX.test(name) &&
    !FRAME_EMBED_RESERVED_ATTRIBUTES.has(name)
  );
}

const FrameEmbedPropsSchema = z.record(
  z.string().refine(isFrameEmbedPropName),
  z.string().regex(/^[^\r\n]*$/)
);

/** `value` as props if the directive can hold them all, or none. */
export function parseFrameEmbedProps(value: unknown): FrameEmbedProps {
  const parsed = FrameEmbedPropsSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

/** The props `parseFrameEmbedProps` reads from JSON, or none from invalid JSON. */
export function parseFrameEmbedPropsJson(
  json: string | null | undefined
): FrameEmbedProps {
  if (!json) {
    return {};
  }
  const parsed = safeParseJSON(json);
  return parsed.isOk() ? parseFrameEmbedProps(parsed.value) : {};
}
