"use client";

import { NavigationProvider } from "@viz/app/components/NavigationProvider";
import {
  makeSendCrossDocumentMessage,
  VisualizationWrapperWithErrorBoundary,
} from "@viz/app/components/VisualizationWrapper";
import {
  CacheDataAPI,
  type PreFetchedFile,
} from "@viz/app/lib/data-apis/cache-data-api";
import { HybridDataAPI } from "@viz/app/lib/data-apis/hybrid-data-api";
import { RPCDataAPI } from "@viz/app/lib/data-apis/rpc-data-api";
import type { FrameProps } from "@viz/app/lib/frame-props";
import type { VizCatalog } from "@viz/app/lib/i18n/catalogs";
import { VizI18nProvider } from "@viz/app/lib/i18n/VizI18nProvider";
import type { VisualizationConfig } from "@viz/app/lib/visualization-api";
import { useMemo } from "react";

// Domains that are trusted and don't require user confirmation before navigation.
// These are Dust platform domains that are considered safe for automatic navigation.
const TRUSTED_NAVIGATION_DOMAINS = ["dust.tt", "eu.dust.tt"];

interface ServerVisualizationWrapperClientProps {
  allowedOrigins: string[];
  identifier: string;
  isAuthenticatedMember?: boolean;
  canInvokePublicFunctions?: boolean;
  isFullHeight?: boolean;
  isPdfMode?: boolean;
  frameProps?: FrameProps;
  catalog: VizCatalog;
  prefetchedCode?: string;
  prefetchedFiles?: PreFetchedFile[];
}

/**
 * Client-side visualization wrapper for server-side rendered visualizations.
 *
 * This component runs on the client and:
 * 1. Receives plain pre-fetched data from the server component (avoids serialization issues)
 * 2. Creates a CacheDataAPI instance using the pre-fetched code and files
 * 3. Uses authenticated RPC for member file access, retaining cached files for other viewers
 *
 * This is the client counterpart to ServerSideVisualizationWrapper and handles
 * the React Server Component serialization boundary by accepting plain objects
 * instead of class instances.
 */
/**
 * @cc [owner:flvndvd;achilleburah,label:security] shared-frame-data-api-selection
 * A shared Frame MUST pick its data API from what the server confirmed about the viewer: a
 * workspace member gets the RPC bridge, a visitor allowed to call public functions sends only
 * function calls over it, and every other view, PDF exports included, reads from the cache.
 */
export function ServerVisualizationWrapperClient({
  identifier,
  allowedOrigins,
  isAuthenticatedMember = false,
  canInvokePublicFunctions = false,
  isFullHeight = false,
  isPdfMode = false,
  frameProps,
  catalog,
  prefetchedCode,
  prefetchedFiles = [],
}: ServerVisualizationWrapperClientProps) {
  const dataAPI = useMemo(() => {
    const cache = new CacheDataAPI(prefetchedFiles, prefetchedCode);
    if (isPdfMode || (!isAuthenticatedMember && !canInvokePublicFunctions)) {
      return cache;
    }

    const sendMessage = makeSendCrossDocumentMessage({
      allowedOrigins,
      identifier,
    });
    return new HybridDataAPI(
      cache,
      new RPCDataAPI(sendMessage),
      isAuthenticatedMember
    );
  }, [
    prefetchedCode,
    prefetchedFiles,
    isAuthenticatedMember,
    canInvokePublicFunctions,
    isPdfMode,
    allowedOrigins,
    identifier,
  ]);

  const config: VisualizationConfig = {
    allowedOrigins,
    dataAPI,
    identifier,
    isFullHeight,
    isPdfMode,
    frameProps,
  };

  return (
    <VizI18nProvider catalog={catalog}>
      <NavigationProvider trustedDomains={TRUSTED_NAVIGATION_DOMAINS}>
        <VisualizationWrapperWithErrorBoundary config={config} />
      </NavigationProvider>
    </VizI18nProvider>
  );
}
