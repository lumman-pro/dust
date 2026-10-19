import {
  historyFolderPath,
  snapshotDocument,
} from "@app/lib/api/documents/history";
import { DustFileSystem } from "@app/lib/api/file_system/dust_file_system";
import { writeConversationFile } from "@app/tests/utils/conversation_files";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { fileStorageMock } from "@app/tests/utils/mocks/file_storage";
import { describe, expect, it } from "vitest";

describe("historyFolderPath", () => {
  it("puts the doc's history at the root of its mount", () => {
    expect(historyFolderPath("conversation-c1/notes/poem.md")).toBe(
      "conversation-c1/.history/notes/poem.md"
    );
  });

  it("refuses a path inside a history folder", () => {
    expect(
      historyFolderPath("conversation-c1/.history/poem.md/2026.md")
    ).toBeNull();
  });
});

describe("snapshotDocument", () => {
  it("copies the doc into its history folder", async () => {
    const { authenticator: auth } = await createResourceTest({});
    const canonicalPath = await writeConversationFile(
      auth,
      "poem.md",
      "# Poem\n"
    );
    const dustFs = await DustFileSystem.fromScopedPath(auth, canonicalPath);
    if (dustFs.isErr()) {
      throw dustFs.error;
    }

    const result = await snapshotDocument(dustFs.value, canonicalPath);

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) {
      return;
    }
    expect(
      result.value.startsWith(`${historyFolderPath(canonicalPath)}/`)
    ).toBe(true);
    const storagePath = dustFs.value.toMountFilePath(result.value);
    expect(storagePath && fileStorageMock.getObject(storagePath)).toBe(
      "# Poem\n"
    );
  });
});
