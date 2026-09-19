export type SourceKind = "file" | "directory" | "symlink";

export interface SourceInfo {
  path: string;
  kind: SourceKind;
  size: number;
  mtimeMs: number;
  objectId?: string;
}

export interface WorkspaceRevision {
  kind: "git" | "snapshot" | "unknown";
  remote?: string;
  ref?: string;
  commit?: string;
}

export interface TreeSource {
  readonly name: string;
  revision(): Promise<WorkspaceRevision | undefined>;
  stat(path: string): Promise<SourceInfo | undefined>;
  listDir(path: string): Promise<readonly SourceInfo[]>;
  readFile(path: string): Promise<Uint8Array>;
  listFiles?(): AsyncIterable<string>;
}

export function normalizeRelative(path: string): string {
  const parts: string[] = [];
  for (const raw of path.replace(/\\/g, "/").split("/")) {
    if (!raw || raw === ".") continue;
    if (raw === "..") parts.pop();
    else parts.push(raw);
  }
  return parts.join("/");
}
