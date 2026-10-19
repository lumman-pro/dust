import type { DustFileSystem } from "@app/lib/api/file_system/dust_file_system";
import { DustFileSystemError } from "@app/types/file_system";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";

// Dot-prefixed so file listings hide it, at the mount root so one folder holds every doc's history.
export const HISTORY_FOLDER_NAME = ".history";

/** `conversation-c1/.history/notes/poem.md` for `conversation-c1/notes/poem.md`. */
export function historyFolderPath(canonicalPath: string): string | null {
  const slash = canonicalPath.indexOf("/");
  if (slash < 0) {
    return null;
  }
  const docPath = canonicalPath.slice(slash + 1);
  if (!docPath || docPath.split("/").includes(HISTORY_FOLDER_NAME)) {
    return null;
  }
  return `${canonicalPath.slice(0, slash)}/${HISTORY_FOLDER_NAME}/${docPath}`;
}

// Names sort in the order snapshots were taken: `2026-10-19T10-00-00-123Z.md`.
function snapshotName(date: Date): string {
  return `${date.toISOString().replace(/[:.]/g, "-")}.md`;
}

function noHistoryError(canonicalPath: string): DustFileSystemError {
  return new DustFileSystemError(
    "invalid_path",
    `Path \`${canonicalPath}\` cannot have a history.`
  );
}

export async function snapshotDocument(
  dustFs: DustFileSystem,
  canonicalPath: string
): Promise<Result<string, DustFileSystemError>> {
  const folder = historyFolderPath(canonicalPath);
  if (!folder) {
    return new Err(noHistoryError(canonicalPath));
  }

  const root = `${canonicalPath.slice(0, canonicalPath.indexOf("/"))}/${HISTORY_FOLDER_NAME}`;
  const created = await dustFs.mkdir(root);
  if (created.isErr() && created.error.code !== "already_exists") {
    return created;
  }

  const snapshotPath = `${folder}/${snapshotName(new Date())}`;
  const copied = await dustFs.copy({ src: canonicalPath, dest: snapshotPath });
  if (copied.isErr()) {
    return copied;
  }
  return new Ok(snapshotPath);
}

export async function listDocumentSnapshots(
  dustFs: DustFileSystem,
  canonicalPath: string
): Promise<Result<string[], DustFileSystemError>> {
  const folder = historyFolderPath(canonicalPath);
  if (!folder) {
    return new Err(noHistoryError(canonicalPath));
  }

  const listed = await dustFs.list(folder);
  if (listed.isErr()) {
    return listed;
  }
  return new Ok(
    listed.value
      .filter((entry) => !entry.isDirectory)
      .map((entry) => entry.path)
      .sort()
      .reverse()
  );
}
