import { formatTimestampToFriendlyDate } from "@app/lib/client/friendly_date";
import { usePokeDfsChildren, usePokeDfsObject } from "@app/poke/swr/dfs";
import type { DfsObjectId } from "@app/types/dfs";
import type { WorkspaceType } from "@app/types/user";
import { File02, Folder, Spinner, Tree } from "@dust-tt/sparkle";
import { useState } from "react";

// A folder of the chain from the tenant root down to an object.
interface DfsAncestor {
  id: DfsObjectId;
  path: string;
}

interface DfsSelection {
  id: DfsObjectId;
  path: string;
  // From the tenant root to the parent of the selected object.
  ancestors: DfsAncestor[];
}

interface DfsFileSystemTreeProps {
  owner: WorkspaceType;
}

/**
 * The workspace's dfs tenant as a folder tree: each folder loads its children when opened, and the
 * selected object's attributes and grants are shown next to the tree.
 */
export function DfsFileSystemTree({ owner }: DfsFileSystemTreeProps) {
  const [selection, setSelection] = useState<DfsSelection | null>(null);

  return (
    <div className="my-4 flex flex-col rounded-lg border p-4">
      <h2 className="pb-4 text-lg font-semibold">File System</h2>
      <div className="flex flex-col gap-6 md:flex-row">
        <div className="min-w-0 md:w-1/2">
          <DfsFolderChildren
            owner={owner}
            path=""
            ancestors={[]}
            selection={selection}
            onSelect={setSelection}
          />
        </div>
        <div className="min-w-0 md:w-1/2">
          {selection ? (
            <DfsObjectDetails owner={owner} selection={selection} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Select a folder or a file to see its attributes and grants.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function DfsFolderChildren({
  owner,
  parentId,
  path,
  ancestors,
  selection,
  onSelect,
}: {
  owner: WorkspaceType;
  // Omitted for the tenant root.
  parentId?: DfsObjectId;
  path: string;
  ancestors: DfsAncestor[];
  selection: DfsSelection | null;
  onSelect: (selection: DfsSelection) => void;
}) {
  const { entries, hasTenant, directoryId, isLoading, isError } =
    usePokeDfsChildren({ owner, parentId });

  if (isError) {
    return <Tree.Empty label="Failed to load this folder." />;
  }
  if (!hasTenant) {
    return <Tree.Empty label="This workspace has no dfs tenant." />;
  }

  // The listed folder is the parent of its entries, and the last of their ancestors.
  const entryAncestors = directoryId
    ? [...ancestors, { id: directoryId, path: path || "/" }]
    : ancestors;

  return (
    <Tree variant="navigator" isLoading={isLoading}>
      {!isLoading && entries.length === 0 && <Tree.Empty label="Empty" />}
      {entries.map((entry) => {
        const entryPath = `${path}/${entry.name}`;
        const select = () =>
          onSelect({
            id: entry.id,
            path: entryPath,
            ancestors: entryAncestors,
          });
        return entry.kind === "directory" ? (
          <Tree.Item
            key={entry.id}
            id={entry.id}
            label={entry.name}
            visual={Folder}
            type="node"
            isSelected={selection?.id === entry.id}
            onItemClick={select}
            renderTreeItems={() => (
              <DfsFolderChildren
                owner={owner}
                parentId={entry.id}
                path={entryPath}
                ancestors={entryAncestors}
                selection={selection}
                onSelect={onSelect}
              />
            )}
          />
        ) : (
          <Tree.Item
            key={entry.id}
            id={entry.id}
            label={entry.name}
            visual={File02}
            type="leaf"
            isSelected={selection?.id === entry.id}
            onItemClick={select}
          />
        );
      })}
    </Tree>
  );
}

function formatMode(mode: number): string {
  return `${mode & 0o4 ? "r" : ""}${mode & 0o2 ? "w" : ""}` || "-";
}

function DfsObjectDetails({
  owner,
  selection,
}: {
  owner: WorkspaceType;
  selection: DfsSelection;
}) {
  const { object, isLoading, isError } = usePokeDfsObject({
    owner,
    objectId: selection.id,
    ancestorIds: selection.ancestors.map((ancestor) => ancestor.id),
  });

  if (isError) {
    return <p className="text-sm">Failed to load this object.</p>;
  }
  if (isLoading || !object) {
    return <Spinner />;
  }

  const pathById = new Map(
    selection.ancestors.map((ancestor) => [ancestor.id, ancestor.path])
  );
  const rows: [string, string][] = [
    ["Path", selection.path],
    ["Object ID", object.id],
    ["Kind", object.kind],
    ["Size", object.kind === "directory" ? "-" : `${object.size} B`],
    ["MIME type", object.mimeType ?? "-"],
    [
      "Created",
      object.createdMs ? formatTimestampToFriendlyDate(object.createdMs) : "-",
    ],
    [
      "Modified",
      object.mtimeMs ? formatTimestampToFriendlyDate(object.mtimeMs) : "-",
    ],
    ...Object.entries(object.xattrs).map(([key, value]): [string, string] => [
      `xattr ${key}`,
      value,
    ]),
  ];

  return (
    <div className="flex flex-col gap-4 text-sm">
      <table className="w-full">
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label} className="border-b border-border">
              <td className="py-1 pr-4 font-medium whitespace-nowrap">
                {label}
              </td>
              <td className="py-1 break-all">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div>
        <h3 className="pb-1 font-medium">Effective grants</h3>
        {object.effectiveGrants.length === 0 ? (
          <p className="text-muted-foreground">None</p>
        ) : (
          <ul className="font-mono">
            {object.effectiveGrants.map((grant) => (
              <li key={grant.subject}>
                ALLOW {grant.subject} {formatMode(grant.mode)}
                {grant.fromId !== object.id &&
                  ` (inherited from ${pathById.get(grant.fromId) ?? grant.fromId})`}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
