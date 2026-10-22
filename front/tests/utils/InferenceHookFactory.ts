import {
  InferenceHookModel,
  InferenceHookVersionModel,
} from "@app/lib/models/inference_hook";
import { InferenceHookResource } from "@app/lib/resources/inference_hook_resource";
import type { UserResource } from "@app/lib/resources/user_resource";
import type { LightWorkspaceType } from "@app/types/user";

export class InferenceHookFactory {
  static async basic(
    workspace: LightWorkspaceType,
    user: UserResource
  ): Promise<InferenceHookResource> {
    const hook = await InferenceHookModel.create({
      workspaceId: workspace.id,
      provider: "dust",
      name: "Test hook",
      currentVersion: 1,
      createdByUserId: user.id,
    });
    await InferenceHookVersionModel.create({
      workspaceId: workspace.id,
      hookId: hook.id,
      version: 1,
      authorId: user.id,
      events: ["before_model_call"],
      enforcement: null,
      onError: "allow",
      timeoutMs: 5_000,
      credentialId: null,
      providerConfig: {},
    });

    return new InferenceHookResource(InferenceHookResource.model, hook.get());
  }
}
