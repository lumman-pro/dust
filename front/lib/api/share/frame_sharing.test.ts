import {
  checkFrameShareScopePermission,
  checkShareScopePermission,
  generateFrameOtpChallenge,
  getFrameFunctionSharingConflict,
  sendFrameOtpEmail,
  validateFrameOtpChallenge,
} from "@app/lib/api/share/frame_sharing";
import { Authenticator } from "@app/lib/auth";
import { isExternalSubscriberId } from "@app/lib/notifications/transactional_emails";
import { notifyFrameLoginCode } from "@app/lib/notifications/triggers/frame-sharing";
import { rateLimiter } from "@app/lib/utils/rate_limiter";
import { FileFactory } from "@app/tests/utils/FileFactory";
import {
  createTestFrameFunction,
  enablePublicFrameFunctions,
} from "@app/tests/utils/FrameFunctionFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { grantWorkspacePermission } from "@app/tests/utils/permissions";
import { SharingGrantFactory } from "@app/tests/utils/SharingGrantFactory";
import { SpaceFactory } from "@app/tests/utils/SpaceFactory";
import { WorkspaceFactory } from "@app/tests/utils/WorkspaceFactory";
import { FRAME_MANIFEST_FILE } from "@app/types/api/frame_manifest";
import type { SandboxFunctionUserIdentityPolicy } from "@app/types/api/sandbox_functions";
import { frameV2ContentType } from "@app/types/files";
import assert from "assert";
import { describe, expect, it, vi } from "vitest";

vi.mock("@app/lib/utils/rate_limiter", () => ({
  rateLimiter: vi.fn().mockResolvedValue(1),
}));

vi.mock("@app/lib/notifications/triggers/frame-sharing", async () => {
  const { Ok } = await import("@app/types/shared/result");
  return {
    notifyFrameLoginCode: vi.fn().mockResolvedValue(new Ok(undefined)),
    notifyFrameShared: vi.fn().mockResolvedValue(new Ok(undefined)),
  };
});

const EMAIL = "user@example.com";
const SHARE_TOKEN = "share-token-abc";

describe("generateFrameOtpChallenge", () => {
  it("returns Ok with a 6-digit code string", async () => {
    const result = await generateFrameOtpChallenge({
      email: EMAIL,
      shareToken: SHARE_TOKEN,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.code).toMatch(/^\d{6}$/);
    }
  });

  it("stores the challenge in Redis (verifiable via validate)", async () => {
    const genResult = await generateFrameOtpChallenge({
      email: EMAIL,
      shareToken: SHARE_TOKEN,
    });
    expect(genResult.isOk()).toBe(true);
    if (!genResult.isOk()) {
      return;
    }

    const validateResult = await validateFrameOtpChallenge({
      email: EMAIL,
      shareToken: SHARE_TOKEN,
      submittedCode: genResult.value.code,
    });
    expect(validateResult.isOk()).toBe(true);
  });

  it("returns Err('rate_limited') when rateLimiter returns 0", async () => {
    vi.mocked(rateLimiter).mockResolvedValueOnce(0);

    const result = await generateFrameOtpChallenge({
      email: EMAIL,
      shareToken: SHARE_TOKEN,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBe("rate_limited");
    }
  });
});

describe("validateFrameOtpChallenge", () => {
  it("returns Ok on correct code", async () => {
    const genResult = await generateFrameOtpChallenge({
      email: EMAIL,
      shareToken: SHARE_TOKEN,
    });
    expect(genResult.isOk()).toBe(true);
    if (!genResult.isOk()) {
      return;
    }

    const result = await validateFrameOtpChallenge({
      email: EMAIL,
      shareToken: SHARE_TOKEN,
      submittedCode: genResult.value.code,
    });
    expect(result.isOk()).toBe(true);
  });

  it("returns Err('expired') when no challenge exists", async () => {
    const result = await validateFrameOtpChallenge({
      email: EMAIL,
      shareToken: SHARE_TOKEN,
      submittedCode: "123456",
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBe("expired");
    }
  });

  it("returns Err('invalid_code') on wrong code", async () => {
    const genResult = await generateFrameOtpChallenge({
      email: EMAIL,
      shareToken: SHARE_TOKEN,
    });
    expect(genResult.isOk()).toBe(true);

    const result = await validateFrameOtpChallenge({
      email: EMAIL,
      shareToken: SHARE_TOKEN,
      submittedCode: "000000",
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBe("invalid_code");
    }
  });

  it("returns Err('max_attempts') after 5 wrong attempts", async () => {
    await generateFrameOtpChallenge({
      email: EMAIL,
      shareToken: SHARE_TOKEN,
    });

    for (let i = 0; i < 5; i++) {
      const result = await validateFrameOtpChallenge({
        email: EMAIL,
        shareToken: SHARE_TOKEN,
        submittedCode: "000000",
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBe("invalid_code");
      }
    }

    const finalResult = await validateFrameOtpChallenge({
      email: EMAIL,
      shareToken: SHARE_TOKEN,
      submittedCode: "000000",
    });
    expect(finalResult.isErr()).toBe(true);
    if (finalResult.isErr()) {
      expect(finalResult.error).toBe("max_attempts");
    }
  });

  it("returns Err('rate_limited') when verify rate limiter is exhausted", async () => {
    await generateFrameOtpChallenge({
      email: EMAIL,
      shareToken: SHARE_TOKEN,
    });

    // The rateLimiter is called by both generate and validate.
    // Mock it to return 0 on the next call (which will be validate's rate limiter).
    vi.mocked(rateLimiter).mockResolvedValueOnce(0);

    const result = await validateFrameOtpChallenge({
      email: EMAIL,
      shareToken: SHARE_TOKEN,
      submittedCode: "123456",
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBe("rate_limited");
    }
  });

  it("deletes the challenge after successful validation", async () => {
    const genResult = await generateFrameOtpChallenge({
      email: EMAIL,
      shareToken: SHARE_TOKEN,
    });
    expect(genResult.isOk()).toBe(true);
    if (!genResult.isOk()) {
      return;
    }

    const firstValidation = await validateFrameOtpChallenge({
      email: EMAIL,
      shareToken: SHARE_TOKEN,
      submittedCode: genResult.value.code,
    });
    expect(firstValidation.isOk()).toBe(true);

    const secondValidation = await validateFrameOtpChallenge({
      email: EMAIL,
      shareToken: SHARE_TOKEN,
      submittedCode: genResult.value.code,
    });
    expect(secondValidation.isErr()).toBe(true);
    if (secondValidation.isErr()) {
      expect(secondValidation.error).toBe("expired");
    }
  });

  it("code is specific to shareToken+email combination", async () => {
    const genResult = await generateFrameOtpChallenge({
      email: EMAIL,
      shareToken: "token-A",
    });
    expect(genResult.isOk()).toBe(true);
    if (!genResult.isOk()) {
      return;
    }

    const result = await validateFrameOtpChallenge({
      email: EMAIL,
      shareToken: "token-B",
      submittedCode: genResult.value.code,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBe("expired");
    }
  });
});

describe("sendFrameOtpEmail", () => {
  it("emails the code to an external recipient in the frame's workspace", async () => {
    const workspace = await WorkspaceFactory.basic();
    const result = await sendFrameOtpEmail({
      to: "outsider@example.com",
      code: "123456",
      sharedByName: "Alice",
      workspace,
    });

    expect(result.isOk()).toBe(true);
    expect(notifyFrameLoginCode).toHaveBeenCalledOnce();
    const [recipient, payload] = vi.mocked(notifyFrameLoginCode).mock.calls[0];
    expect(payload).toMatchObject({
      workspaceId: workspace.sId,
      workspaceName: workspace.name,
      sharedByName: "Alice",
      code: "123456",
      expiresInMinutes: 15,
    });
    expect(recipient.email).toBe("outsider@example.com");
    expect(isExternalSubscriberId(recipient.subscriberId)).toBe(true);
  });
});

describe("getFrameFunctionSharingConflict", () => {
  const DECLARES_FUNCTIONS = { declaresFunctions: true };

  async function setupFrame() {
    const { authenticator: auth, user } = await createResourceTest({
      role: "admin",
    });
    const frame = await FileFactory.create(auth, null, {
      contentType: frameV2ContentType,
      fileName: FRAME_MANIFEST_FILE,
      fileSize: 32,
      status: "ready",
      useCase: "conversation",
    });
    await frame.ensureShareableFrame(auth);

    return { auth, frame, user };
  }

  it("returns no conflict for a Frame shared with the workspace only", async () => {
    const { auth, frame } = await setupFrame();
    await frame.setShareScope(auth, "workspace_and_emails");

    expect(
      await getFrameFunctionSharingConflict(auth, frame, DECLARES_FUNCTIONS)
    ).toBeNull();
  });

  it("reports a conflict when the Frame is shared publicly", async () => {
    const { auth, frame } = await setupFrame();
    await frame.setShareScope(auth, "public");

    const conflict = await getFrameFunctionSharingConflict(
      auth,
      frame,
      DECLARES_FUNCTIONS
    );
    assert(conflict, "Expected a sharing conflict");
    expect(conflict).toContain("anyone holding its link");
    expect(conflict).toContain("restrict the Frame's sharing");
  });

  it("returns no conflict for a public share when the workspace serves public functions", async () => {
    const { auth, frame } = await setupFrame();
    await enablePublicFrameFunctions(auth);
    await frame.setShareScope(auth, "public");

    expect(
      await getFrameFunctionSharingConflict(auth, frame, DECLARES_FUNCTIONS)
    ).toBeNull();
  });

  it("ignores external grants on a public share when the workspace serves public functions", async () => {
    const { auth, frame } = await setupFrame();
    await enablePublicFrameFunctions(auth);
    await SharingGrantFactory.create(auth, frame, {
      kind: "email",
      value: "outsider@example.com",
    });
    await frame.setShareScope(auth, "public");

    expect(
      await getFrameFunctionSharingConflict(auth, frame, DECLARES_FUNCTIONS)
    ).toBeNull();
  });

  it("reports a conflict when a grant reaches an email outside the workspace", async () => {
    const { auth, frame } = await setupFrame();
    await frame.setShareScope(auth, "workspace_and_emails");
    await SharingGrantFactory.create(auth, frame, {
      kind: "email",
      value: "outsider@example.com",
    });

    const conflict = await getFrameFunctionSharingConflict(
      auth,
      frame,
      DECLARES_FUNCTIONS
    );
    assert(conflict, "Expected a sharing conflict");
    expect(conflict).toContain("1 recipient outside the workspace");
  });

  it("returns no conflict when every grant is a workspace member", async () => {
    const { auth, frame, user } = await setupFrame();
    await frame.setShareScope(auth, "workspace_and_emails");
    await SharingGrantFactory.create(auth, frame, {
      kind: "email",
      value: user.email,
    });

    expect(
      await getFrameFunctionSharingConflict(auth, frame, DECLARES_FUNCTIONS)
    ).toBeNull();
  });

  it("returns no conflict for a publicly shared Frame whose update declares no function", async () => {
    const { auth, frame } = await setupFrame();
    await frame.setShareScope(auth, "public");

    expect(
      await getFrameFunctionSharingConflict(auth, frame, {
        declaresFunctions: false,
      })
    ).toBeNull();
  });

  it("reports a conflict for a publicly shared Frame whose active publication already declares functions", async () => {
    const {
      authenticator: auth,
      user,
      workspace,
    } = await createResourceTest({
      role: "admin",
    });
    const space = await SpaceFactory.project(workspace, user.id);
    const { frame } = await createTestFrameFunction(auth, { space });
    await frame.setShareScope(auth, "public");

    expect(
      await getFrameFunctionSharingConflict(auth, frame, DECLARES_FUNCTIONS)
    ).toContain("anyone holding its link");
  });
});

describe("checkFrameShareScopePermission", () => {
  async function setupFrameWithFunction(
    userIdentity: SandboxFunctionUserIdentityPolicy
  ) {
    const {
      authenticator: auth,
      user,
      workspace,
    } = await createResourceTest({
      role: "admin",
    });
    const space = await SpaceFactory.project(workspace, user.id);
    const { frame } = await createTestFrameFunction(auth, {
      space,
      userIdentity,
      executionMode: "fast",
    });

    return { auth, frame };
  }

  it("refuses to share a Frame with functions publicly", async () => {
    const { auth, frame } = await setupFrameWithFunction("public");

    const result = await checkFrameShareScopePermission(auth, "public", frame);

    expect(result.isErr()).toBe(true);
  });

  it("shares a Frame with a public function publicly when the workspace serves public functions", async () => {
    const { auth, frame } = await setupFrameWithFunction("public");
    await enablePublicFrameFunctions(auth);

    const result = await checkFrameShareScopePermission(auth, "public", frame);

    expect(result.isOk()).toBe(true);
  });

  it("refuses to share a Frame whose functions are all private publicly", async () => {
    const { auth, frame } = await setupFrameWithFunction(
      "workspace_user_required"
    );
    await enablePublicFrameFunctions(auth);

    const result = await checkFrameShareScopePermission(auth, "public", frame);

    assert(result.isErr(), "Expected public sharing to be refused");
    expect(result.error.message).toContain("None of this Frame's functions");
  });
});

describe("checkShareScopePermission", () => {
  const PUBLISH_FRAME = {
    grantType: "publish",
    resourceType: "frame",
  } as const;

  it("allows a public scope with the all_scopes policy and the publish permission", async () => {
    const { authenticator, user, workspace } = await createResourceTest({});
    await WorkspaceFactory.setSharingPolicy(workspace, "all_scopes");
    await grantWorkspacePermission(
      authenticator.getNonNullableWorkspace(),
      user,
      PUBLISH_FRAME
    );
    const auth = await Authenticator.fromUserIdAndWorkspaceId(
      user.sId,
      workspace.sId
    );

    expect(checkShareScopePermission(auth, "public").isOk()).toBe(true);
  });

  it("refuses a public scope when the workspace policy forbids it", async () => {
    const { authenticator, user, workspace } = await createResourceTest({});
    await WorkspaceFactory.setSharingPolicy(workspace, "workspace_and_emails");
    await grantWorkspacePermission(
      authenticator.getNonNullableWorkspace(),
      user,
      PUBLISH_FRAME
    );
    const auth = await Authenticator.fromUserIdAndWorkspaceId(
      user.sId,
      workspace.sId
    );

    const result = checkShareScopePermission(auth, "public");

    assert(result.isErr(), "Expected public sharing to be refused");
    expect(result.error.message).toBe(
      "Public sharing is disabled for this workspace."
    );
  });

  it("refuses a public scope without the publish permission", async () => {
    const { user, workspace } = await createResourceTest({});
    await WorkspaceFactory.setSharingPolicy(workspace, "all_scopes");
    const auth = await Authenticator.fromUserIdAndWorkspaceId(
      user.sId,
      workspace.sId
    );

    const result = checkShareScopePermission(auth, "public");

    assert(result.isErr(), "Expected public sharing to be refused");
    expect(result.error.message).toBe(
      "You do not have permission to share this frame publicly."
    );
  });

  it("allows non-public scopes without the policy or the permission", async () => {
    const { authenticator: auth } = await createResourceTest({});

    expect(checkShareScopePermission(auth, "emails_only").isOk()).toBe(true);
    expect(checkShareScopePermission(auth, "workspace_and_emails").isOk()).toBe(
      true
    );
  });
});
