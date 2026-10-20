// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { Slide, Slideshow } from "@viz/components/dust/slideshow/v2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderSlideshow(props: {
  initialPage?: number | string;
  onPageChange?: (page: number) => void;
}) {
  render(
    <Slideshow {...props}>
      <Slide>First</Slide>
      <Slide>Second</Slide>
      <Slide>Third</Slide>
    </Slideshow>
  );
}

function pressKey(key: string) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key }));
  });
}

describe("Slideshow page", () => {
  it.each([
    [undefined, "First"],
    [2, "Second"],
    ["2", "Second"],
    ["99", "Third"],
    ["0", "First"],
    ["1.5", "First"],
    ["abc", "First"],
  ])("starts on the slide of initialPage=%s", (initialPage, expectedSlide) => {
    renderSlideshow({ initialPage });

    expect(screen.getByText(expectedSlide)).toBeDefined();
  });

  it("reports each page change, but not the initial page or no-op navigation", () => {
    const onPageChange = vi.fn();
    renderSlideshow({ initialPage: "2", onPageChange });
    expect(onPageChange).not.toHaveBeenCalled();

    pressKey("ArrowRight");
    pressKey("ArrowRight");
    pressKey("ArrowLeft");
    pressKey("ArrowLeft");
    pressKey("ArrowLeft");

    expect(screen.getByText("First")).toBeDefined();
    expect(onPageChange.mock.calls).toEqual([[3], [2], [1]]);
  });
});
