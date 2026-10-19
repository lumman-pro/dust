import { FrameDraftControls } from "@app/components/assistant/conversation/interactive_content/frame/FrameDraftControls";
import { LightWorkspaceFactory } from "@app/tests/utils/LightWorkspaceFactory";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  makeDraftLive: vi.fn(
    async (_publicationId: string, _options: { hasChanges: boolean }) => true
  ),
}));

vi.mock("@app/hooks/useMakeFrameDraftLive", () => ({
  useMakeFrameDraftLive: () => mocks.makeDraftLive,
}));

const owner = LightWorkspaceFactory.build({ sId: "workspace-sid" });

function renderControls({
  draftPublicationId,
  onValidated = async () => undefined,
}: {
  draftPublicationId: string | null;
  onValidated?: () => Promise<unknown>;
}) {
  return render(
    <FrameDraftControls
      owner={owner}
      frameId="frame-sid"
      draftPublicationId={draftPublicationId}
      livePublicationId="publication-live"
      hideLabels={false}
      onValidated={onValidated}
    />
  );
}

describe("FrameDraftControls", () => {
  beforeEach(() => {
    mocks.makeDraftLive.mockClear();
  });

  it("makes the pending draft live, then refreshes the panel", async () => {
    const user = userEvent.setup();
    let finishValidating: (madeLive: boolean) => void = () => {};
    mocks.makeDraftLive.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishValidating = resolve;
        })
    );
    const onValidated = vi.fn(async () => undefined);
    renderControls({ draftPublicationId: "publication-draft", onValidated });

    await user.click(screen.getByRole("button", { name: "Validate draft" }));

    expect(mocks.makeDraftLive).toHaveBeenCalledWith("publication-draft", {
      hasChanges: true,
    });
    expect(onValidated).not.toHaveBeenCalled();
    finishValidating(true);
    await waitFor(() => expect(onValidated).toHaveBeenCalledTimes(1));
  });

  it("names the live publication when nothing changed, which only ends draft mode", async () => {
    const user = userEvent.setup();
    const onValidated = vi.fn(async () => undefined);
    renderControls({ draftPublicationId: null, onValidated });

    await user.click(screen.getByRole("button", { name: "Validate draft" }));

    await waitFor(() => expect(onValidated).toHaveBeenCalledTimes(1));
    expect(mocks.makeDraftLive).toHaveBeenCalledWith("publication-live", {
      hasChanges: false,
    });
  });

  it("still refreshes the panel when validating fails (a newer draft replaced it)", async () => {
    const user = userEvent.setup();
    mocks.makeDraftLive.mockResolvedValueOnce(false);
    const onValidated = vi.fn(async () => undefined);
    renderControls({ draftPublicationId: "publication-draft", onValidated });

    await user.click(screen.getByRole("button", { name: "Validate draft" }));

    await waitFor(() => expect(onValidated).toHaveBeenCalledTimes(1));
    expect(
      screen.getByRole("button", { name: "Validate draft" })
    ).toBeEnabled();
  });
});
