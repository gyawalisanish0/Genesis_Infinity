import type { ApiProviderId } from "./apiProviders.js";

export interface ApiModelOption {
  id: string;
  label: string;
}

interface OpenRouterModel {
  id: string;
  name: string;
  pricing: { prompt: string; completion: string };
  supported_parameters?: string[];
}

/**
 * Free, tool-calling-capable models from OpenRouter's public model list -
 * this engine's turn loop requires tool calling (get_scope, action, etc.),
 * so a model without it can't actually run a turn even if it's free.
 * OpenRouter's list endpoint needs no auth, so this works even before an
 * OPENROUTER_API_KEY is configured (the key is only needed to actually use
 * a model afterward).
 */
async function listFreeOpenRouterModels(): Promise<ApiModelOption[]> {
  const response = await fetch("https://openrouter.ai/api/v1/models");
  if (!response.ok) {
    throw new Error(`OpenRouter model list failed (HTTP ${response.status})`);
  }
  const data = (await response.json()) as { data: OpenRouterModel[] };
  return data.data
    .filter(
      (model) =>
        model.pricing.prompt === "0" &&
        model.pricing.completion === "0" &&
        (model.supported_parameters ?? []).includes("tools"),
    )
    .map((model) => ({ id: model.id, label: model.name }));
}

/**
 * Per-provider free-model listers. A provider with no entry here (e.g.
 * Hugging Face, which has no equivalent public "list free models" endpoint)
 * simply returns an empty list - the frontend falls back to manual model-id
 * entry for those.
 */
const MODEL_LISTERS: Partial<Record<ApiProviderId, () => Promise<ApiModelOption[]>>> = {
  openrouter: listFreeOpenRouterModels,
};

export async function listApiModels(provider: ApiProviderId): Promise<ApiModelOption[]> {
  const lister = MODEL_LISTERS[provider];
  return lister ? lister() : [];
}
