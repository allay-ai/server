import { settings } from "../../../features/settings/settings";

export const DEFAULT_MODEL = "openai/gpt-6-luna";
export const DEFAULT_SEARCH_MODEL = "perplexity/sonar";

// Perplexity models search but can't call tools. v1 deployments set one as the main model;
// move it to search instead of breaking every run that needs a tool.
const searchOnly = (model: string | undefined) => !!model && model.startsWith("perplexity/");

// Read on every run, so a change in the admin panel applies to the next one.
export const openrouterEnv = () => {
  const model = settings.get("OPENROUTER_API_MODEL");
  const searchModel = settings.source("SEARCH_MODEL") === "default" && searchOnly(model) ? model : settings.get("SEARCH_MODEL");
  return {
    apiKey: settings.get("OPENROUTER_API_KEY"),
    baseURL: settings.get("OPENROUTER_API_URL"),
    model: searchOnly(model) ? DEFAULT_MODEL : model,
    searchModel,
    searchContext: settings.get("OPENROUTER_API_CTX"),
    reasoningEffort: settings.get("OPENROUTER_REASONING_EFFORT") as "low" | "medium" | "high" | undefined,
    apiUrl: settings.get("API_URL"),
    apiName: settings.get("API_NAME"),
  };
};
