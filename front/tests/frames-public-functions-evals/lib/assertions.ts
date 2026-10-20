import type {
  AssertionResult,
  GeneratedFunction,
  TestCase,
} from "@app/tests/frames-public-functions-evals/lib/types";
import { isString } from "@app/types/shared/utils/general";
import { z } from "zod";

const ManifestSchema = z.object({
  functions: z
    .array(
      z.object({
        name: z.string(),
        entryPoint: z.string(),
        executionMode: z.enum(["fast", "durable"]).optional(),
      })
    )
    .default([]),
});

const USER_IDENTITY_REGEX = /["']?userIdentity["']?\s*:\s*["']([a-z_]+)["']/;
const RELATIVE_IMPORT_REGEX = /from\s+["'](\.{1,2}\/[^"']+)["']/g;

function resolveRelativePath(fromPath: string, importPath: string): string {
  const segments = fromPath.split("/").slice(0, -1);
  for (const segment of importPath.replace(/\.ts$/, "").split("/")) {
    if (segment === "..") {
      segments.pop();
    } else if (segment !== ".") {
      segments.push(segment);
    }
  }

  return `${segments.join("/")}.ts`;
}

function collectImportedSource(
  files: Map<string, string>,
  entryPath: string
): string {
  const visited = new Set<string>();
  const pending = [entryPath];
  let source = "";
  while (pending.length > 0) {
    const path = pending.pop() ?? "";
    const content = files.get(path);
    if (visited.has(path) || content === undefined) {
      continue;
    }
    visited.add(path);
    source += `${content}\n`;
    for (const [, importPath] of content.matchAll(RELATIVE_IMPORT_REGEX)) {
      pending.push(resolveRelativePath(path, importPath));
    }
  }

  return source;
}

function parseGeneratedFunctions(
  files: Map<string, string>
): GeneratedFunction[] | string {
  const manifestPath = [...files.keys()].find(
    (path) => path === "manifest.json" || path.endsWith("/manifest.json")
  );
  if (!manifestPath) {
    return "No manifest.json was written.";
  }

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(files.get(manifestPath) ?? "");
  } catch {
    return `${manifestPath} is not valid JSON.`;
  }
  const manifest = ManifestSchema.safeParse(manifestJson);
  if (!manifest.success) {
    return `${manifestPath} does not declare functions as expected.`;
  }

  const frameFolder = manifestPath.slice(0, -"manifest.json".length);

  return manifest.data.functions.map((fn) => {
    const entryPath = `${frameFolder}${fn.entryPoint}`;
    const entrySource = files.get(entryPath) ?? "";

    return {
      name: fn.name,
      executionMode: fn.executionMode ?? "durable",
      userIdentity: entrySource.match(USER_IDENTITY_REGEX)?.[1] ?? null,
      source: collectImportedSource(files, entryPath),
    };
  });
}

function checkPublicFunction(fn: GeneratedFunction): string | null {
  if (fn.source === "") {
    return `Function "${fn.name}" has no source file at its entry point.`;
  }
  if (fn.executionMode !== "fast") {
    return `Public function "${fn.name}" is ${fn.executionMode}, not fast.`;
  }
  if (fn.source.includes("DSEC_")) {
    return `Public function "${fn.name}" references a DSEC_ secret.`;
  }
  if (fn.source.includes("tools.call")) {
    return `Public function "${fn.name}" calls Dust tools.`;
  }

  return null;
}

export function validateGeneratedFrame(
  testCase: TestCase,
  files: Map<string, string>
): AssertionResult {
  const functions = parseGeneratedFunctions(files);
  if (isString(functions)) {
    return { success: false, error: functions };
  }

  const publicFunctions = functions.filter(
    (fn) => fn.userIdentity === "public"
  );
  for (const fn of publicFunctions) {
    const error = checkPublicFunction(fn);
    if (error) {
      return { success: false, error };
    }
  }

  for (const { namePattern, policy } of testCase.functionExpectations) {
    const matching = functions.filter((fn) => namePattern.test(fn.name));
    const isPublic = (fn: GeneratedFunction) => fn.userIdentity === "public";
    const hasExpectedPolicy =
      policy === "public"
        ? matching.some(isPublic)
        : matching.length > 0 && !matching.some(isPublic);
    if (!hasExpectedPolicy) {
      return {
        success: false,
        error: `No ${policy} function matches ${namePattern}. Functions: ${functions
          .map((fn) => `${fn.name} (${fn.userIdentity ?? "default"})`)
          .join(", ")}`,
      };
    }
  }

  const hasToolCallingDurableFunction = functions.some(
    (fn) =>
      fn.userIdentity !== "public" &&
      fn.executionMode === "durable" &&
      fn.source.includes("tools.call")
  );
  if (
    testCase.requiresToolCallingDurableFunction &&
    !hasToolCallingDurableFunction
  ) {
    return {
      success: false,
      error: "No non-public durable function calls Dust tools.",
    };
  }

  return { success: true };
}
