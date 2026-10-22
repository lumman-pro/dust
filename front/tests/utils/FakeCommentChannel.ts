import type { CommentChannel } from "@app/lib/client/collab/comments";
import type { DfmComment } from "@app/lib/markdown/dfm";
import { Err } from "@app/types/shared/result";

export function fakeCommentChannel(initial: DfmComment[] | null = null) {
  const listeners = new Set<(comments: DfmComment[]) => void>();
  let threads = initial;
  const channel: CommentChannel = {
    getThreads: () => threads,
    onThreads: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: async () => new Err("unavailable"),
    close: () => {
      threads = null;
      listeners.clear();
    },
  };
  const push = (comments: DfmComment[]) => {
    threads = comments;
    listeners.forEach((listener) => listener(comments));
  };
  return { channel, push };
}
