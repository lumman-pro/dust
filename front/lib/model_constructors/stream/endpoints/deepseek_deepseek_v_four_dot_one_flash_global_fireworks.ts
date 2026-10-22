import { WithDeepSeekDeepSeekV41FlashConfig } from "@app/lib/model_constructors/providers/fireworks/models/deepseek_v_four_dot_one_flash";
import { FireworksResponsesStream } from "@app/lib/model_constructors/stream/clients/fireworks_responses";
import type { StreamEndpointConstructor } from "@app/lib/model_constructors/stream/configuration";
import { DEEPSEEK_LAB } from "@app/lib/model_constructors/types/labs";
import { GLOBAL } from "@app/lib/model_constructors/types/regions";

export class DeepSeekDeepSeekVFourDotOneFlashGlobalFireworksStream extends WithDeepSeekDeepSeekV41FlashConfig(
  FireworksResponsesStream
) {
  // Verified 2026-10-21: https://fireworks.ai/models/deepseek-ai/deepseek-v4p1-flash
  static readonly tokenPricing = {
    cacheHit: 0.006,
    standardInput: 0.3,
    standardOutput: 1.2,
  };
  static readonly lab = DEEPSEEK_LAB;
  static readonly region = GLOBAL;
  static readonly id = this.buildId();
}
DeepSeekDeepSeekVFourDotOneFlashGlobalFireworksStream satisfies StreamEndpointConstructor;
