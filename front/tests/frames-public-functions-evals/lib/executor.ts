import type { Authenticator } from "@app/lib/auth";
import { buildFramesV2Instructions } from "@app/lib/resources/skill/code_defined/global/frames_v2";
import { MODEL_ID } from "@app/tests/frames-public-functions-evals/lib/config";
import type {
  ExecutionResult,
  TestCase,
} from "@app/tests/frames-public-functions-evals/lib/types";
import { getEvalStreamLLM } from "@app/tests/utils/eval_llm";

const OUTPUT_FORMAT = `\
# Output format

You cannot run commands in this session. Write every file of the Frame folder you would create, \
each wrapped in a <file path="<FrameFolder>/<relative path>"> tag and closed with </file>. Paths \
are relative to the parent of the Frame folder, so the manifest is <FrameFolder>/manifest.json. \
Write complete files without markdown code fences inside the tags, then stop.`;

const FILE_TAG_REGEX = /<file path="([^"]+)">\n?([\s\S]*?)<\/file>/g;

function parseFiles(responseText: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const [, path, content] of responseText.matchAll(FILE_TAG_REGEX)) {
    files.set(path.trim(), content);
  }

  return files;
}

export async function executeFramesAuthoring(
  auth: Authenticator,
  testCase: TestCase
): Promise<ExecutionResult> {
  const llm = await getEvalStreamLLM(auth, { modelId: MODEL_ID });

  const instructions = buildFramesV2Instructions({
    hasFunctions: true,
    hasPublicFunctions: true,
    isPod: false,
  });

  const events = llm.stream({
    conversation: {
      messages: [
        {
          role: "user",
          name: "User",
          content: [{ type: "text", text: testCase.userMessage }],
        },
      ],
    },
    prompt: `${instructions}\n\n${OUTPUT_FORMAT}`,
    specifications: [],
  });

  let responseText = "";
  for await (const event of events) {
    if (event.type === "text_delta") {
      responseText += event.content.delta;
    }
    if (event.type === "error") {
      throw new Error(`Frames authoring error: ${event.content.message}`);
    }
  }

  return { responseText, files: parseFiles(responseText) };
}
