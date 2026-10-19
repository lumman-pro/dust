import { longestStreak } from "longest-streak";

/**
 * @cc [owner:avervaet,label:coding] markdown-code-fence
 * The returned fence MUST be at least three characters and longer than any run of `char` in the
 * code, so no line of the code can close it.
 */
export const codeFence = (code: string, char: "`" | "~" = "`") =>
  char.repeat(Math.max(longestStreak(code, char) + 1, 3));
