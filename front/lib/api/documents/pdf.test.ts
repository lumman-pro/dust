// @vitest-environment node
import assert from "node:assert";
import { renderDocumentHtml } from "@app/lib/api/documents/pdf";
import { describe, expect, it } from "vitest";

const SOURCE = [
  "---",
  "title: Notes",
  "---",
  "",
  "# Snow & ice",
  "",
  "Snow :comment-start{id=c1}loosens at dawn:comment-end{id=c1}.",
  "",
  "- [ ] Wax the skis",
  "- [x] Check the forecast",
  "",
  '::embed_frame{path="pod-p/Clock/Clock.tsx"}',
  "",
  ":::annotations",
  "::comment{id=c1 status=open}",
  "",
  '::message{author=user:usr_1 name="Yuka" at=2026-09-25T14:16:32.380Z}',
  "",
  "Really?",
  ":::",
  "",
].join("\n");

function render(title = "notes") {
  const result = renderDocumentHtml(SOURCE, title);
  assert(result.isOk());
  return result.value;
}

describe("renderDocumentHtml", () => {
  it("renders the body as a page titled by the file name", () => {
    const html = render("a & b");

    expect(html).toContain("<title>a &amp; b</title>");
    expect(html).toContain("Snow &amp; ice</h1>");
    expect(html).toContain(">Snow loosens at dawn.</p>");
    expect(html).not.toContain("title: Notes");
  });

  it("drops comment threads and comment marks", () => {
    const html = render();

    expect(html).not.toContain("Really?");
    expect(html).not.toContain("Yuka");
    expect(html).not.toContain("data-comment-id");
  });

  it("keeps the task attributes and the Frame placeholder", () => {
    const html = render();

    expect(html).toMatch(/ data-task="true"><p[^>]*>Wax the skis/);
    expect(html).toMatch(
      / data-task="true" data-checked="true"><p[^>]*>Check the forecast/
    );
    expect(html).toMatch(
      /<div data-document-frame="pod-p\/Clock\/Clock.tsx">pod-p\/Clock\/Clock.tsx<\/div>/
    );
  });

  it("refuses a document the editor cannot load", () => {
    const result = renderDocumentHtml(
      "An anchor :comment-start{id=c1}without a thread.\n",
      "notes"
    );

    expect(result.isErr() && result.error.code).toBe("not_exportable");
  });
});
