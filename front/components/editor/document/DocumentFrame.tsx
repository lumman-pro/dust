import { DocumentEmbedsContext } from "@app/components/editor/document/DocumentEmbeds";
import { asOwnUndoStep } from "@app/components/editor/document/undoSteps";
import type {
  FrameEmbedProps,
  FrameEmbedSource,
} from "@app/lib/markdown/frame_embed";
import {
  findFrameEmbedDirective,
  getFrameEmbedSourceLabel,
  parseFrameEmbedDirective,
  parseFrameEmbedHeight,
  parseFrameEmbedProps,
  parseFrameEmbedPropsJson,
  parseFrameEmbedSource,
  serializeFrameEmbedDirective,
} from "@app/lib/markdown/frame_embed";
import { Node } from "@tiptap/core";
import type { NodeViewProps } from "@tiptap/react";
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import { useContext, useMemo, useState } from "react";

export const DOCUMENT_FRAME_NODE_NAME = "frameEmbed";

const DEFAULT_FRAME_HEIGHT_PX = 600;

const FRAME_PATH_ATTRIBUTE = "data-document-frame";
const FRAME_FILE_ID_ATTRIBUTE = "data-document-frame-file-id";
const FRAME_HEIGHT_ATTRIBUTE = "data-height";
const FRAME_PROPS_ATTRIBUTE = "data-props";

// Empty props are stored as the attribute's default, null, so a Frame inserted without props, as
// the `/` menu does, compares equal to the one its Markdown reads back as when the document saves.
const propsAttribute = (props: FrameEmbedProps): FrameEmbedProps | null =>
  Object.keys(props).length > 0 ? props : null;

interface DocumentFrameSourceProps {
  source: FrameEmbedSource;
}

export const DocumentFrameFallback = ({ source }: DocumentFrameSourceProps) => (
  <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
    {getFrameEmbedSourceLabel(source)}
  </p>
);

interface DocumentFrameDisplayProps extends DocumentFrameSourceProps {
  height: number | null;
  frameProps: FrameEmbedProps;
}

export const DocumentFrameDisplay = ({
  source,
  height,
  frameProps,
}: DocumentFrameDisplayProps) => {
  const { renderFrame } = useContext(DocumentEmbedsContext);

  return renderFrame ? (
    <>{renderFrame(source, height ?? DEFAULT_FRAME_HEIGHT_PX, frameProps)}</>
  ) : (
    <DocumentFrameFallback source={source} />
  );
};

const sourceAttributes = (source: FrameEmbedSource) => ({
  path: source.kind === "file_path" ? source.path : null,
  fileId: source.kind === "file_id" ? source.fileId : null,
});

/**
 * @cc [owner:tdraier,label:product] document-frame-menu
 * In an editable document, hovering a Frame MUST show, at its top right, a menu with a height
 * slider from 200px to 1600px and an action to remove it that leaves the editor focused. Dragging
 * the slider MUST preview the height and save it once, on release, so each action is its own
 * undoable edit, never merged with the edits around it, that changes only the hovered Frame. A
 * drag ending without a change MUST restore the Frame's height.
 * The menu MUST stay while the pointer is on the Frame or the slider is dragged, and hide otherwise.
 */
const DocumentFrameView = ({
  node,
  editor,
  updateAttributes,
  deleteNode,
}: NodeViewProps) => {
  const { renderFrameMenu } = useContext(DocumentEmbedsContext);
  const [hovering, setHovering] = useState(false);
  const [draftHeight, setDraftHeight] = useState<number | null>(null);
  const source = useMemo(
    () =>
      parseFrameEmbedSource({
        path: node.attrs.path,
        fileId: node.attrs.fileId,
      }),
    [node.attrs.path, node.attrs.fileId]
  );
  const height = draftHeight ?? parseFrameEmbedHeight(node.attrs.height);
  const frameProps = useMemo(
    () => parseFrameEmbedProps(node.attrs.props),
    [node.attrs.props]
  );

  const commitHeight = (nextHeight: number) => {
    setDraftHeight(null);
    asOwnUndoStep(editor, () => updateAttributes({ height: nextHeight }));
  };

  return (
    <NodeViewWrapper
      contentEditable={false}
      className="relative my-6"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {source && (
        <DocumentFrameDisplay
          source={source}
          height={height}
          frameProps={frameProps}
        />
      )}
      {renderFrameMenu &&
        (hovering || draftHeight !== null) &&
        renderFrameMenu({
          height: height ?? DEFAULT_FRAME_HEIGHT_PX,
          onPreviewHeight: setDraftHeight,
          onEndPreview: () => setDraftHeight(null),
          onCommitHeight: commitHeight,
          onRemove: () => {
            asOwnUndoStep(editor, deleteNode);
            editor.commands.focus();
          },
        })}
    </NodeViewWrapper>
  );
};

/**
 * @cc [owner:tdraier,label:product;security] document-frame-embed
 * A frame embed MUST be read only from a `frame-embed-directive` line, never as a list item's
 * first block, which the schema holds only as a paragraph, and MUST keep its path or file id,
 * height and props through load, save, copy and paste. Pasted content MUST NOT create one with no
 * source `parseFrameEmbedSource` accepts, nor keep props `parseFrameEmbedProps` refuses. It MUST
 * display only through the host's `renderFrame`, given its source and props, at its height or
 * 600px without one, and without a renderer as its path or file id, so the editor never loads a
 * Frame the host did not resolve.
 * Events inside it MUST reach the Frame, not the editor.
 */
export const DocumentFrame = Node.create({
  name: DOCUMENT_FRAME_NODE_NAME,
  group: "block",
  atom: true,
  isolating: true,
  addAttributes: () => ({
    path: {
      default: null,
      rendered: false,
      parseHTML: (element) => element.getAttribute(FRAME_PATH_ATTRIBUTE),
    },
    fileId: {
      default: null,
      rendered: false,
      parseHTML: (element) => element.getAttribute(FRAME_FILE_ID_ATTRIBUTE),
    },
    height: {
      default: null,
      rendered: false,
      parseHTML: (element) =>
        parseFrameEmbedHeight(element.getAttribute(FRAME_HEIGHT_ATTRIBUTE)),
    },
    props: {
      default: null,
      rendered: false,
      parseHTML: (element) =>
        propsAttribute(
          parseFrameEmbedPropsJson(element.getAttribute(FRAME_PROPS_ATTRIBUTE))
        ),
    },
  }),
  parseHTML: () => [
    {
      tag: `div[${FRAME_PATH_ATTRIBUTE}], div[${FRAME_FILE_ID_ATTRIBUTE}]`,
      getAttrs: (element) => {
        const source = parseFrameEmbedSource({
          path: element.getAttribute(FRAME_PATH_ATTRIBUTE),
          fileId: element.getAttribute(FRAME_FILE_ID_ATTRIBUTE),
        });
        return source ? sourceAttributes(source) : false;
      },
    },
  ],
  renderHTML: ({ node }) => {
    const source = parseFrameEmbedSource({
      path: node.attrs.path,
      fileId: node.attrs.fileId,
    });
    const height = parseFrameEmbedHeight(node.attrs.height);
    const props = parseFrameEmbedProps(node.attrs.props);
    return [
      "div",
      {
        ...(source?.kind === "file_id"
          ? { [FRAME_FILE_ID_ATTRIBUTE]: source.fileId }
          : { [FRAME_PATH_ATTRIBUTE]: source?.path ?? "" }),
        ...(height ? { [FRAME_HEIGHT_ATTRIBUTE]: String(height) } : {}),
        ...(Object.keys(props).length > 0
          ? { [FRAME_PROPS_ATTRIBUTE]: JSON.stringify(props) }
          : {}),
      },
      source ? getFrameEmbedSourceLabel(source) : "",
    ];
  },
  renderText: ({ node }) => {
    const source = parseFrameEmbedSource({
      path: node.attrs.path,
      fileId: node.attrs.fileId,
    });
    return source ? getFrameEmbedSourceLabel(source) : "";
  },
  addNodeView: () =>
    ReactNodeViewRenderer(DocumentFrameView, { stopEvent: () => true }),
  markdownTokenizer: {
    name: DOCUMENT_FRAME_NODE_NAME,
    level: "block",
    start: (src) => findFrameEmbedDirective(src),
    tokenize: (src) => {
      const parsed = parseFrameEmbedDirective(src);
      return parsed
        ? {
            type: DOCUMENT_FRAME_NODE_NAME,
            raw: parsed.raw,
            attrs: {
              ...sourceAttributes(parsed.source),
              height: parsed.height,
              props: propsAttribute(parsed.props),
            },
          }
        : undefined;
    },
  },
  parseMarkdown: (token) => ({
    type: DOCUMENT_FRAME_NODE_NAME,
    attrs: {
      path: token.attrs?.path,
      fileId: token.attrs?.fileId,
      height: token.attrs?.height,
      props: token.attrs?.props,
    },
  }),
  renderMarkdown: (node) => {
    const source = parseFrameEmbedSource({
      path: node.attrs?.path,
      fileId: node.attrs?.fileId,
    });
    return source
      ? serializeFrameEmbedDirective(
          source,
          parseFrameEmbedHeight(node.attrs?.height),
          parseFrameEmbedProps(node.attrs?.props)
        )
      : "";
  },
});
