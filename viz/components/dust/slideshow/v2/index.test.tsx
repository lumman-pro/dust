// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { Slide, Slideshow } from "@viz/components/dust/slideshow/v2";
import { useState } from "react";
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

interface DeckProps {
  currentPage?: number | string;
  onPageChange?: (page: number) => void;
}

function Deck(props: DeckProps) {
  return (
    <Slideshow {...props}>
      <Slide>First</Slide>
      <Slide>Second</Slide>
      <Slide>Third</Slide>
    </Slideshow>
  );
}

function StatefulDeck({
  onPageChange,
}: {
  onPageChange: (page: number) => void;
}) {
  const [currentPage, setCurrentPage] = useState(2);
  return (
    <Deck
      currentPage={currentPage}
      onPageChange={(page) => {
        onPageChange(page);
        setCurrentPage(page);
      }}
    />
  );
}

function pressKey(key: string) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key }));
  });
}

describe("Slideshow page", () => {
  it.each([
    [2, "Second"],
    ["2", "Second"],
    ["99", "Third"],
    ["0", "First"],
    ["1.5", "First"],
    ["abc", "First"],
  ])("shows the slide of currentPage=%s", (currentPage, expectedSlide) => {
    render(<Deck currentPage={currentPage} />);

    expect(screen.getByText(expectedSlide)).toBeDefined();
  });

  it("follows currentPage changes", () => {
    const { rerender } = render(<Deck currentPage={1} />);
    expect(screen.getByText("First")).toBeDefined();

    rerender(<Deck currentPage={3} />);

    expect(screen.getByText("Third")).toBeDefined();
    expect(screen.queryByText("First")).toBeNull();
  });

  it("requests navigation without moving when controlled", () => {
    const onPageChange = vi.fn();
    render(<Deck currentPage={2} onPageChange={onPageChange} />);

    pressKey("ArrowRight");

    expect(screen.getByText("Second")).toBeDefined();
    expect(onPageChange.mock.calls).toEqual([[3]]);
  });

  it("moves when the caller applies the requested page, ignoring no-op navigation", () => {
    const onPageChange = vi.fn();
    render(<StatefulDeck onPageChange={onPageChange} />);
    expect(screen.getByText("Second")).toBeDefined();

    for (const [key, expectedSlide] of [
      ["ArrowRight", "Third"],
      ["ArrowRight", "Third"],
      ["ArrowLeft", "Second"],
      ["ArrowLeft", "First"],
      ["ArrowLeft", "First"],
    ]) {
      pressKey(key);
      expect(screen.getByText(expectedSlide)).toBeDefined();
    }

    expect(onPageChange.mock.calls).toEqual([[3], [2], [1]]);
  });

  it("navigates on its own and reports pages when uncontrolled", () => {
    const onPageChange = vi.fn();
    render(<Deck onPageChange={onPageChange} />);
    expect(screen.getByText("First")).toBeDefined();

    pressKey("ArrowRight");

    expect(screen.getByText("Second")).toBeDefined();
    expect(onPageChange.mock.calls).toEqual([[2]]);
  });
});
