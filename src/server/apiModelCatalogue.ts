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

interface HuggingFaceRouterModel {
  id: string;
  providers: Array<{ supports_tools?: boolean }>;
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
 * Tool-calling-capable models from Hugging Face's Inference Providers
 * router (https://router.huggingface.co/v1/models, public/no-auth, see
 * docs/BACKEND_ARCHITECTURE.md) - same tool-calling requirement as
 * OpenRouter's lister, but no "free" filter: unlike OpenRouter's real
 * always-free tier, HF's per-provider `is_free` flag marks only a
 * temporary promo and is false for effectively every model, so filtering
 * on it would always yield an empty list. A model qualifies here if *any*
 * of its listed providers supports tool calling - actually using a chosen
 * model still costs the configured HF_API_KEY's usual HF credits.
 */
async function listHuggingFaceModels(): Promise<ApiModelOption[]> {
  const response = await fetch("https://router.huggingface.co/v1/models");
  if (!response.ok) {
    throw new Error(`Hugging Face model list failed (HTTP ${response.status})`);
  }
  const data = (await response.json()) as { data: HuggingFaceRouterModel[] };
  return data.data
    .filter((model) => model.providers.some((provider) => provider.supports_tools))
    .map((model) => ({ id: model.id, label: model.id }));
}

/**
 * Per-provider model listers, populating the frontend's model dropdown.
 * A provider with no entry here would return an empty list, falling back
 * to manual model-id entry - currently every known provider has one.
 */
const MODEL_LISTERS: Partial<Record<ApiProviderId, () => Promise<ApiModelOption[]>>> = {
  huggingface: listHuggingFaceModels,
  openrouter: listFreeOpenRouterModels,
};

export async function listApiModels(provider: ApiProviderId): Promise<ApiModelOption[]> {
  const lister = MODEL_LISTERS[provider];
  return lister ? lister() : [];
}
