/**
 * Known OpenAI-compatible API providers apiDriver.ts can talk to. Base
 * URLs are public constants baked in here; only an API key (one env var
 * per provider) is needed to enable one. Adding a new provider later is
 * one entry here plus a new secret - the frontend picks it up automatically
 * via GET /api/backend/providers, no other code changes needed.
 */
export const KNOWN_API_PROVIDERS = {
  huggingface: { label: "Hugging Face", baseURL: "https://router.huggingface.co/v1", envVar: "HF_API_KEY" },
  openrouter: { label: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", envVar: "OPENROUTER_API_KEY" },
} as const;

export type ApiProviderId = keyof typeof KNOWN_API_PROVIDERS;

export interface ConfiguredApiProvider {
  baseURL: string;
  apiKey: string;
}

export function isKnownApiProvider(id: string): id is ApiProviderId {
  return id in KNOWN_API_PROVIDERS;
}
