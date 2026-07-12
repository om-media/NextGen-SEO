import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { KeyRound, Loader2, PlugZap, Trash2 } from "lucide-react";
import { deleteInternalLinkProviderSettings, fetchInternalLinkProviderSettings, saveInternalLinkProviderSettings, type InternalLinkProviderSetting } from "@/src/services/internalLinksService";

const providers = [
  { baseUrl: "https://api.openai.com/v1", embeddingModel: "text-embedding-3-small", label: "OpenAI", provider: "openai", reviewModel: "gpt-4.1-mini" },
  { baseUrl: "https://api.anthropic.com", embeddingModel: "", label: "Anthropic", provider: "anthropic", reviewModel: "claude-3-5-haiku-latest" },
  { baseUrl: "https://generativelanguage.googleapis.com", embeddingModel: "text-embedding-004", label: "Gemini", provider: "gemini", reviewModel: "gemini-1.5-flash" },
  { baseUrl: "https://api.jina.ai/v1", embeddingModel: "jina-embeddings-v3", label: "Jina", provider: "jina", reviewModel: "" },
  { baseUrl: "https://api.cohere.com", embeddingModel: "embed-v4.0", label: "Cohere", provider: "cohere", reviewModel: "" },
  { baseUrl: "https://api.voyageai.com/v1", embeddingModel: "voyage-3-lite", label: "Voyage", provider: "voyage", reviewModel: "" },
  { baseUrl: "https://api.openrouter.ai/api/v1", embeddingModel: "", label: "OpenRouter", provider: "openrouter", reviewModel: "openai/gpt-4.1-mini" },
  { baseUrl: "http://127.0.0.1:11434", embeddingModel: "bge-m3", label: "Ollama", provider: "ollama", reviewModel: "llama3.1" },
];

type ProviderDraft = {
  apiKey: string;
  apiKeyPreview: string | null;
  baseUrl: string;
  embeddingModel: string;
  enabled: boolean;
  hasApiKey: boolean;
  reviewModel: string;
};

function defaultDraft(provider: typeof providers[number]): ProviderDraft {
  return {
    apiKey: "",
    apiKeyPreview: null,
    baseUrl: provider.baseUrl,
    embeddingModel: provider.embeddingModel,
    enabled: true,
    hasApiKey: false,
    reviewModel: provider.reviewModel,
  };
}

function draftFromSetting(provider: typeof providers[number], setting?: InternalLinkProviderSetting): ProviderDraft {
  return {
    ...defaultDraft(provider),
    apiKeyPreview: setting?.apiKeyPreview || null,
    baseUrl: setting?.baseUrl || provider.baseUrl,
    embeddingModel: setting?.embeddingModel || provider.embeddingModel,
    enabled: setting?.enabled ?? true,
    hasApiKey: Boolean(setting?.hasApiKey),
    reviewModel: setting?.reviewModel || provider.reviewModel,
  };
}

function providerMap(settings: InternalLinkProviderSetting[]) {
  return new Map(settings.map((setting) => [setting.provider, setting]));
}

function upsertProviderSetting(settings: InternalLinkProviderSetting[], nextSetting: InternalLinkProviderSetting) {
  const next = settings.filter((setting) => setting.provider !== nextSetting.provider);
  next.push(nextSetting);
  return next.sort((left, right) => left.provider.localeCompare(right.provider));
}

export function InternalLinkProviderSettings() {
  const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>(() => Object.fromEntries(providers.map((provider) => [provider.provider, defaultDraft(provider)])));
  const [settings, setSettings] = useState<InternalLinkProviderSetting[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingProvider, setSavingProvider] = useState<string | null>(null);

  const connectedCount = useMemo(() => settings.length, [settings]);

  async function loadSettings() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchInternalLinkProviderSettings();
      const map = providerMap(response.settings);
      setSettings(response.settings);
      setDrafts(Object.fromEntries(providers.map((provider) => [provider.provider, draftFromSetting(provider, map.get(provider.provider))])));
    } catch (err: any) {
      setError(err.message || "Unable to load provider settings.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSettings();
  }, []);

  function updateDraft(provider: string, patch: Partial<ProviderDraft>) {
    setDrafts((current) => ({
      ...current,
      [provider]: {
        ...current[provider],
        ...patch,
      },
    }));
  }

  async function saveProvider(provider: typeof providers[number]) {
    const draft = drafts[provider.provider];
    setSavingProvider(provider.provider);
    setError(null);
    try {
      const response = await saveInternalLinkProviderSettings(provider.provider, {
        apiKey: draft.apiKey.trim() || undefined,
        baseUrl: draft.baseUrl.trim() || null,
        embeddingModel: draft.embeddingModel.trim() || null,
        enabled: draft.enabled,
        reviewModel: draft.reviewModel.trim() || null,
      });
      setSettings((current) => upsertProviderSetting(current, response.setting));
      updateDraft(provider.provider, draftFromSetting(provider, response.setting));
    } catch (err: any) {
      setError(err.message || `Unable to save ${provider.label} settings.`);
    } finally {
      setSavingProvider(null);
    }
  }

  async function clearProviderKey(provider: typeof providers[number]) {
    setSavingProvider(provider.provider);
    setError(null);
    try {
      const response = await saveInternalLinkProviderSettings(provider.provider, { clearApiKey: true });
      setSettings((current) => upsertProviderSetting(current, response.setting));
      updateDraft(provider.provider, draftFromSetting(provider, response.setting));
    } catch (err: any) {
      setError(err.message || `Unable to clear ${provider.label} key.`);
    } finally {
      setSavingProvider(null);
    }
  }

  async function removeProvider(provider: typeof providers[number]) {
    setSavingProvider(provider.provider);
    setError(null);
    try {
      await deleteInternalLinkProviderSettings(provider.provider);
      setSettings((current) => current.filter((setting) => setting.provider !== provider.provider));
      updateDraft(provider.provider, defaultDraft(provider));
    } catch (err: any) {
      setError(err.message || `Unable to remove ${provider.label} settings.`);
    } finally {
      setSavingProvider(null);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">Internal Links AI providers</p>
          <p className="text-sm text-muted-foreground">Configure optional hosted providers and Ollama. Built-in BGE-M3 requires no provider settings.</p>
        </div>
        <Badge variant="outline">{loading ? "Loading" : `${connectedCount} configured`}</Badge>
      </div>

      {error && <p className="mt-3 rounded-xl border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

      <div className="mt-4 grid gap-3">
        {providers.map((provider) => {
          const draft = drafts[provider.provider] || defaultDraft(provider);
          const saving = savingProvider === provider.provider;
          return (
            <div key={provider.provider} className="rounded-xl border border-border bg-background p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-card"><PlugZap className="h-4 w-4" /></span>
                  <div>
                    <p className="text-sm font-semibold">{provider.label}</p>
                    <p className="text-xs text-muted-foreground">{draft.hasApiKey ? `Key ${draft.apiKeyPreview}` : provider.provider === "ollama" ? "Local endpoint, no hosted key required" : "No key stored"}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Label htmlFor={`internal-link-provider-${provider.provider}-enabled`} className="text-xs text-muted-foreground">Enabled</Label>
                  <Switch id={`internal-link-provider-${provider.provider}-enabled`} checked={draft.enabled} onCheckedChange={(checked) => updateDraft(provider.provider, { enabled: checked })} />
                </div>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor={`internal-link-provider-${provider.provider}-key`}>API key</Label>
                  <Input
                    id={`internal-link-provider-${provider.provider}-key`}
                    type="password"
                    value={draft.apiKey}
                    onChange={(event) => updateDraft(provider.provider, { apiKey: event.target.value })}
                    placeholder={draft.hasApiKey ? "Stored; enter a new key to replace" : provider.provider === "ollama" ? "Optional for local Ollama" : "Paste API key"}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`internal-link-provider-${provider.provider}-base-url`}>Base URL</Label>
                  <Input id={`internal-link-provider-${provider.provider}-base-url`} value={draft.baseUrl} onChange={(event) => updateDraft(provider.provider, { baseUrl: event.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`internal-link-provider-${provider.provider}-embedding`}>Embedding model</Label>
                  <Input id={`internal-link-provider-${provider.provider}-embedding`} value={draft.embeddingModel} onChange={(event) => updateDraft(provider.provider, { embeddingModel: event.target.value })} placeholder="Optional" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`internal-link-provider-${provider.provider}-review`}>Review model</Label>
                  <Input id={`internal-link-provider-${provider.provider}-review`} value={draft.reviewModel} onChange={(event) => updateDraft(provider.provider, { reviewModel: event.target.value })} placeholder="Optional" />
                </div>
              </div>

              <div className="mt-4 flex flex-wrap justify-end gap-2">
                {draft.hasApiKey && <Button type="button" variant="ghost" size="sm" onClick={() => clearProviderKey(provider)} disabled={saving}><KeyRound className="mr-2 h-4 w-4" />Clear key</Button>}
                <Button type="button" variant="ghost" size="sm" onClick={() => removeProvider(provider)} disabled={saving}><Trash2 className="mr-2 h-4 w-4" />Remove</Button>
                <Button type="button" size="sm" onClick={() => saveProvider(provider)} disabled={saving || loading}>
                  {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Save provider
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

