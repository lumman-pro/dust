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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function renderSlideshow(props: {
  initialPageFromUrl?: boolean;
  syncPageToUrl?: boolean;
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

function getCurrentPageParam() {
  return new URL(window.location.href).searchParams.get("currentPage");
}

describe("Slideshow current page URL", () => {
  it.each([
    ["2", "Second"],
    ["99", "Third"],
    ["0", "First"],
    ["1.5", "First"],
    ["abc", "First"],
  ])(
    "starts on the slide of currentPage=%s with initialPageFromUrl",
    (page, expectedSlide) => {
      window.history.replaceState(null, "", `/?currentPage=${page}`);

      renderSlideshow({ initialPageFromUrl: true });

      expect(screen.getByText(expectedSlide)).toBeDefined();
    }
  );

  it("ignores and keeps the URL without the options", () => {
    window.history.replaceState(null, "", "/?currentPage=2&other=x");

    renderSlideshow({});
    expect(screen.getByText("First")).toBeDefined();

    pressKey("ArrowRight");
    expect(screen.getByText("Second")).toBeDefined();
    expect(window.location.search).toBe("?currentPage=2&other=x");
  });

  it("writes the active slide to the URL with syncPageToUrl, keeping other params and history", () => {
    window.history.replaceState(null, "", "/?other=x");
    const historyLength = window.history.length;

    renderSlideshow({ syncPageToUrl: true });
    expect(getCurrentPageParam()).toBe("1");

    pressKey("ArrowRight");
    pressKey("ArrowRight");
    expect(screen.getByText("Third")).toBeDefined();
    expect(getCurrentPageParam()).toBe("3");
    expect(new URL(window.location.href).searchParams.get("other")).toBe("x");
    expect(window.history.length).toBe(historyLength);
  });

  it("keeps navigating when the browser refuses to rewrite the URL", () => {
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {
      throw new DOMException("Refused", "SecurityError");
    });

    renderSlideshow({ syncPageToUrl: true });
    pressKey("ArrowRight");

    expect(screen.getByText("Second")).toBeDefined();
  });
});
