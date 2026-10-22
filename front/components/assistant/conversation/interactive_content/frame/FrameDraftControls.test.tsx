import { FrameDraftControls } from "@app/components/assistant/conversation/interactive_content/frame/FrameDraftControls";
import { LightWorkspaceFactory } from "@app/tests/utils/LightWorkspaceFactory";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enterDraftMode: vi.fn(async () => true),
  makeDraftLive: vi.fn(
    async (_publicationId: string, _options: { hasChanges: boolean }) => true
  ),
}));

vi.mock("@app/hooks/useEnterFrameDraftMode", () => ({
  useEnterFrameDraftMode: () => mocks.enterDraftMode,
}));
vi.mock("@app/hooks/useMakeFrameDraftLive", () => ({
  useMakeFrameDraftLive: () => mocks.makeDraftLive,
}));

const owner = LightWorkspaceFactory.build({ sId: "workspace-sid" });

function renderControls({
  canEnterDraftMode = true,
  draftMode,
  draftPublicationId = null,
  onDraftModeChanged = async () => undefined,
}: {
  canEnterDraftMode?: boolean;
  draftMode: boolean;
  draftPublicationId?: string | null;
  onDraftModeChanged?: () => Promise<unknown>;
}) {
  return render(
    <FrameDraftControls
      owner={owner}
      frameId="frame-sid"
      canEnterDraftMode={canEnterDraftMode}
      draftMode={draftMode}
      draftPublicationId={draftPublicationId}
      livePublicationId="publication-live"
      hideLabels={false}
      onDraftModeChanged={onDraftModeChanged}
    />
  );
}

describe("FrameDraftControls", () => {
  // Radix menus measure their content, which jsdom cannot.
  beforeAll(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  });

  beforeEach(() => {
    mocks.enterDraftMode.mockClear();
    mocks.makeDraftLive.mockClear();
  });

  describe("outside draft mode", () => {
    it("turns draft mode on from the more menu, then refreshes", async () => {
      const user = userEvent.setup();
      let finishEntering: (entered: boolean) => void = () => {};
      mocks.enterDraftMode.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finishEntering = resolve;
          })
      );
      const onDraftModeChanged = vi.fn(async () => undefined);
      renderControls({ draftMode: false, onDraftModeChanged });

      await user.click(screen.getByRole("button", { name: "More actions" }));
      await user.click(
        await screen.findByRole("menuitem", { name: "Activate draft mode" })
      );

      expect(mocks.enterDraftMode).toHaveBeenCalledTimes(1);
      expect(onDraftModeChanged).not.toHaveBeenCalled();
      await act(async () => {
        finishEntering(true);
      });
      await waitFor(() => expect(onDraftModeChanged).toHaveBeenCalledTimes(1));
    });

    it("does not refresh when turning draft mode on fails", async () => {
      const user = userEvent.setup();
      mocks.enterDraftMode.mockResolvedValueOnce(false);
      const onDraftModeChanged = vi.fn(async () => undefined);
      renderControls({ draftMode: false, onDraftModeChanged });

      await user.click(screen.getByRole("button", { name: "More actions" }));
      await user.click(
        await screen.findByRole("menuitem", { name: "Activate draft mode" })
      );

      await waitFor(() =>
        expect(mocks.enterDraftMode).toHaveBeenCalledTimes(1)
      );
      expect(onDraftModeChanged).not.toHaveBeenCalled();
    });

    it("shows nothing when draft mode cannot be entered", () => {
      renderControls({ draftMode: false, canEnterDraftMode: false });

      expect(
        screen.queryByRole("button", { name: "More actions" })
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Validate draft" })
      ).not.toBeInTheDocument();
    });
  });

  describe("in draft mode", () => {
    it("makes the pending draft live, then refreshes", async () => {
      const user = userEvent.setup();
      let finishValidating: (madeLive: boolean) => void = () => {};
      mocks.makeDraftLive.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finishValidating = resolve;
          })
      );
      const onDraftModeChanged = vi.fn(async () => undefined);
      renderControls({
        draftMode: true,
        draftPublicationId: "publication-draft",
        onDraftModeChanged,
      });

      expect(
        screen.queryByRole("button", { name: "More actions" })
      ).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Validate draft" }));

      expect(mocks.makeDraftLive).toHaveBeenCalledWith("publication-draft", {
        hasChanges: true,
      });
      expect(onDraftModeChanged).not.toHaveBeenCalled();
      await act(async () => {
        finishValidating(true);
      });
      await waitFor(() => expect(onDraftModeChanged).toHaveBeenCalledTimes(1));
    });

    it("names the live publication when nothing changed, which only ends draft mode", async () => {
      const user = userEvent.setup();
      const onDraftModeChanged = vi.fn(async () => undefined);
      renderControls({ draftMode: true, onDraftModeChanged });

      await user.click(screen.getByRole("button", { name: "Validate draft" }));

      await waitFor(() => expect(onDraftModeChanged).toHaveBeenCalledTimes(1));
      expect(mocks.makeDraftLive).toHaveBeenCalledWith("publication-live", {
        hasChanges: false,
      });
    });

    it("still refreshes when validating fails (a newer draft replaced it)", async () => {
      const user = userEvent.setup();
      mocks.makeDraftLive.mockResolvedValueOnce(false);
      const onDraftModeChanged = vi.fn(async () => undefined);
      renderControls({
        draftMode: true,
        draftPublicationId: "publication-draft",
        onDraftModeChanged,
      });

      await user.click(screen.getByRole("button", { name: "Validate draft" }));

      await waitFor(() => expect(onDraftModeChanged).toHaveBeenCalledTimes(1));
      expect(
        screen.getByRole("button", { name: "Validate draft" })
      ).toBeEnabled();
    });
  });
});
