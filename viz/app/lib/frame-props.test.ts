import { getFramePropsFromSearchParams } from "@viz/app/lib/frame-props";
import { describe, expect, it } from "vitest";

describe("getFramePropsFromSearchParams", () => {
  it("reads each props. param as a string prop", () => {
    expect(
      getFramePropsFromSearchParams({
        identifier: "viz-1",
        locale: "fr-FR",
        "props.region": "EU & UK",
        "props.year": "2026",
        "props.empty": "",
        "props.repeated": ["first", "second"],
      })
    ).toEqual({
      region: "EU & UK",
      year: "2026",
      empty: "",
      repeated: "first",
    });
  });

  it.each([
    "props.",
    "prop.region",
    "props.key",
    "props.ref",
    "props._a",
    "props.1a",
    "props.a-b",
  ])("does not read %s as a prop", (param) => {
    expect(getFramePropsFromSearchParams({ [param]: "x" })).toEqual({});
  });
});
