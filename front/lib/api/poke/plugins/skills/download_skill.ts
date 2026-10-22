import { createPlugin } from "@app/lib/api/poke/types";
import { concurrentExecutor } from "@app/lib/utils/async_utils";
import { streamToBuffer } from "@app/lib/utils/streams";
import { Err, Ok } from "@app/types/shared/result";
import { slugify } from "@app/types/shared/utils/string_utils";
import AdmZip from "adm-zip";
import * as yaml from "js-yaml";

const ATTACHMENT_READ_CONCURRENCY = 4;

export const downloadSkillPlugin = createPlugin({
  manifest: {
    id: "download-skill",
    name: "Download Skill",
    description:
      "Download the skill as a ZIP archive (SKILL.md and attached files) that can be re-imported.",
    resourceTypes: ["skills"],
    readonly: true,
    args: {},
    requiredRoles: ["support"],
  },
  execute: async (auth, resource) => {
    if (!resource) {
      return new Err(new Error("Skill not found"));
    }

    const attachments = resource.getFileAttachments();
    const attachmentContents = await concurrentExecutor(
      attachments,
      (file) =>
        streamToBuffer(file.getReadStream({ auth, version: "original" })),
      { concurrency: ATTACHMENT_READ_CONCURRENCY }
    );

    // Mirrors the layout expected by the ZIP import: one directory holding SKILL.md (frontmatter
    // per https://agentskills.io/specification) and the attachments at their relative paths.
    const skillDir = slugify(resource.name);
    const frontmatter = yaml.dump({
      name: resource.name,
      description: resource.agentFacingDescription,
    });

    const zip = new AdmZip();
    zip.addFile(
      `${skillDir}/SKILL.md`,
      Buffer.from(`---\n${frontmatter}---\n\n${resource.instructions}`, "utf-8")
    );

    for (const [i, file] of attachments.entries()) {
      const contentRes = attachmentContents[i];
      if (contentRes.isErr()) {
        return new Err(
          new Error(
            `Failed to read attachment ${file.fileName}: ${contentRes.error}`
          )
        );
      }
      zip.addFile(`${skillDir}/${file.fileName}`, contentRes.value);
    }

    return new Ok({
      display: "file",
      value: `Skill exported with ${attachments.length} attachment(s).`,
      filename: `${skillDir}.zip`,
      contentType: "application/zip",
      content: zip.toBuffer().toString("base64"),
    });
  },
  isApplicableTo: (_auth, resource) => {
    return resource !== null && resource.kind === "custom";
  },
});
