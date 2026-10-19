import {
  FRAME_EMBED_PROP_NAME_REGEX,
  findFrameEmbedDirective,
  isFrameEmbedPath,
  parseFrameEmbedDirective,
  parseFrameEmbedHeight,
  parseFrameEmbedProps,
  parseFrameEmbedPropsJson,
  parseFrameEmbedSource,
  REACT_RESERVED_PROP_NAMES,
  serializeFrameEmbedDirective,
} from "@app/lib/markdown/frame_embed";
import { describe, expect, it } from "vitest";
import {
  FRAME_PROP_NAME_REGEX,
  REACT_RESERVED_PROP_NAMES as VIZ_REACT_RESERVED_PROP_NAMES,
} from "../../../viz/app/lib/frame-props";

const atPath = (path: string) => ({ kind: "file_path" as const, path });
const FILE_ID = "fil_Q8Ac4uf35L";

describe("frame embed directive", () => {
  it("reads back the path or file id it writes", () => {
    for (const source of [
      atPath("pod-abc/dashboards/revenue.tsx"),
      atPath('conversation-c1/a "b" & c.tsx'),
      { kind: "file_id" as const, fileId: FILE_ID },
    ]) {
      expect(
        parseFrameEmbedDirective(`${serializeFrameEmbedDirective(source)}\n`)
          ?.source
      ).toEqual(source);
    }
    expect(
      serializeFrameEmbedDirective({ kind: "file_id", fileId: FILE_ID }, 400, {
        form: "circle",
      })
    ).toBe(`::embed_frame{fileId="${FILE_ID}" height="400" form="circle"}`);
  });

  it("reads back the height it writes", () => {
    for (const height of [1, 400, 99999]) {
      expect(
        parseFrameEmbedDirective(
          `${serializeFrameEmbedDirective(atPath("pod-abc/x.tsx"), height)}\n`
        )
      ).toMatchObject({ source: atPath("pod-abc/x.tsx"), height });
    }
    expect(
      parseFrameEmbedDirective(
        serializeFrameEmbedDirective(atPath("pod-abc/x.tsx"))
      )
    ).toMatchObject({ height: null });
  });

  it("reads back the props it writes, in order", () => {
    const props = {
      region: "EU",
      year: "2026",
      label: 'a "b" & <c>',
      empty: "",
    };
    for (const height of [null, 400]) {
      const parsed = parseFrameEmbedDirective(
        `${serializeFrameEmbedDirective(atPath("pod-abc/x.tsx"), height, props)}\n`
      );
      expect(parsed).toMatchObject({
        source: atPath("pod-abc/x.tsx"),
        height,
        props,
      });
      expect(Object.keys(parsed?.props ?? {})).toEqual(Object.keys(props));
    }
    expect(
      parseFrameEmbedDirective('::embed_frame{path="pod-abc/x.tsx"}')?.props
    ).toEqual({});
  });

  it.each([
    ['::embed_frame{height="400" path="pod-abc/x.tsx"}', {}],
    [
      '::embed_frame{region="EU" path="pod-abc/x.tsx" height="400"}',
      { region: "EU" },
    ],
    [
      '::embed_frame{path="pod-abc/x.tsx" region="EU" height="400"}',
      { region: "EU" },
    ],
  ])("reads the attributes of %j in any order", (src, props) => {
    const parsed = parseFrameEmbedDirective(src);
    expect(parsed).toMatchObject({
      source: atPath("pod-abc/x.tsx"),
      height: 400,
    });
    expect(parsed?.props).toEqual(props);
  });

  it("reads a file id in any position", () => {
    expect(
      parseFrameEmbedDirective(
        `::embed_frame{form="circle" fileId="${FILE_ID}" height="400"}`
      )
    ).toMatchObject({
      source: { kind: "file_id", fileId: FILE_ID },
      height: 400,
      props: { form: "circle" },
    });
  });

  it.each([
    '::embed_frame{path="pod-abc/x.tsx" title=X}',
    '::embed_frame{path="pod-abc/x.tsx" a="1" a="2"}',
    '::embed_frame{path="pod-abc/x.tsx" path="pod-abc/y.tsx"}',
    `::embed_frame{path="pod-abc/x.tsx" fileId="${FILE_ID}"}`,
    `::embed_frame{fileId="${FILE_ID}" path="pod-abc/x.tsx"}`,
    `::embed_frame{fileId="${FILE_ID}" fileId="${FILE_ID}"}`,
    '::embed_frame{fileId="fil_short"}',
    '::embed_frame{fileId="pod-abc/x.tsx"}',
    '::embed_frame{fileId=""}',
    '::embed_frame{path="pod-abc/x.tsx" height="400" height="400"}',
    '::embed_frame{height="400" region="EU"}',
    "::embed_frame{}",
    '::embed_frame{path="pod-abc/x.tsx" a="b\rc"}',
    '::embed_frame{path="pod-abc/a\rb.tsx"}',
    '::embed_frame{path="pod-abc/x.tsx" key="x"}',
    '::embed_frame{path="pod-abc/x.tsx" ref="x"}',
    '::embed_frame{path="pod-abc/x.tsx" 1a="x"}',
    '::embed_frame{path="pod-abc/x.tsx" _a="x"}',
    '::embed_frame{path="pod-abc/x.tsx" data-x="x"}',
    '::embed_frame{path="pod-abc/x.tsx" a="b & c"}',
    '::embed_frame{path="pod-abc/x.tsx"  a="x"}',
    "::embed_frame{path=\"pod-abc/x.tsx\" a='x'}",
    '::embed_frame{path="pod-abc/x.tsx" height="0"}',
    '::embed_frame{path="pod-abc/x.tsx" height="040"}',
    '::embed_frame{path="pod-abc/x.tsx" height="400px"}',
    '::embed_frame{path="pod-abc/x.tsx" height="100000"}',
    '::embed_frame{path="pod-abc/x.tsx" height=400}',
    "::embed_frame{path=pod-abc/x.tsx}",
    '::embed_frame{path=""}',
    '::embed_frame{path="pod-abc/x.tsx"} trailing',
    ':embed_frame{path="pod-abc/x.tsx"}',
    '::embed_frame{path="pod-abc/<draft>.tsx"}',
    '::embed_frame{path="pod-abc/a & b.tsx"}',
    '::embed_frame{path="pod-abc/it\'s.tsx"}',
  ])("does not read %j", (src) => {
    expect(parseFrameEmbedDirective(src)).toBeNull();
  });

  it("names props as viz reads them", () => {
    expect(FRAME_EMBED_PROP_NAME_REGEX.source).toBe(
      FRAME_PROP_NAME_REGEX.source
    );
    expect(REACT_RESERVED_PROP_NAMES).toEqual(VIZ_REACT_RESERVED_PROP_NAMES);
  });

  it("finds a directive only at the start of a line", () => {
    expect(findFrameEmbedDirective('Intro\n::embed_frame{path="a"}')).toBe(6);
    expect(findFrameEmbedDirective('Intro ::embed_frame{path="a"}')).toBe(-1);
    expect(findFrameEmbedDirective('::embed_frame{path="a"}')).toBe(-1);
  });

  it.each([0, -1, 1.5, 100000, "abc", null])(
    "refuses the height %j",
    (height) => {
      expect(parseFrameEmbedHeight(height)).toBeNull();
    }
  );

  it("reads props only when the directive can hold them all", () => {
    expect(parseFrameEmbedProps({ region: "EU", year: "2026" })).toEqual({
      region: "EU",
      year: "2026",
    });
    for (const invalid of [
      { path: "x" },
      { fileId: FILE_ID },
      { height: "1" },
      { key: "x" },
      { ref: "x" },
      { _a: "x" },
      { "data-x": "x" },
      { multi: "a\nb" },
      { count: 1 },
    ]) {
      expect(parseFrameEmbedProps({ region: "EU", ...invalid })).toEqual({});
    }
    for (const value of [null, "region", ["EU"]]) {
      expect(parseFrameEmbedProps(value)).toEqual({});
    }
    expect(parseFrameEmbedPropsJson('{"region":"EU"}')).toEqual({
      region: "EU",
    });
    for (const json of [null, undefined, "", "{", "[1]"]) {
      expect(parseFrameEmbedPropsJson(json)).toEqual({});
    }
  });

  it("reads a source from a path, else a file id", () => {
    expect(
      parseFrameEmbedSource({ path: "pod-abc/x.tsx", fileId: FILE_ID })
    ).toEqual(atPath("pod-abc/x.tsx"));
    expect(parseFrameEmbedSource({ path: null, fileId: FILE_ID })).toEqual({
      kind: "file_id",
      fileId: FILE_ID,
    });
    for (const attrs of [
      { path: "", fileId: null },
      { path: null, fileId: "fil_short" },
      { path: 1, fileId: undefined },
    ]) {
      expect(parseFrameEmbedSource(attrs)).toBeNull();
    }
  });

  it.each(["", "pod-abc/a\nb.tsx", "pod-abc/a\rb.tsx"])(
    "refuses the path %j",
    (path) => {
      expect(isFrameEmbedPath(path)).toBe(false);
    }
  );
});
