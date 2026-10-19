import { useRouter as useNextRouter } from "next/router";
import { useMemo } from "react";

import type { AppRouter } from "@marketing/lib/platform/types";

import { NextLinkWrapper } from "./NextLinkWrapper";

export function useAppRouter(): AppRouter {
  const router = useNextRouter();
  return useMemo(
    () => ({
      push: router.push,
      replace: router.replace,
      back: router.back,
      reload: router.reload,
      pathname: router.pathname,
      asPath: router.asPath,
      query: router.query as Record<string, string | string[] | undefined>,
      isReady: router.isReady,
      events: router.events,
    }),
    [router]
  );
}

export const LinkWrapper = NextLinkWrapper;

export type { AppRouter };
