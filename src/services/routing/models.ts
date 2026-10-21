import { AVAILABLE_MODELS, getAvailableModels } from "~/lib/config"
import { getAntigravityCatalog, setDiscoveredAntigravityModelIds } from "~/lib/model-catalog"
import { isSeparateThinkingModelsEnabled, isHiddenCodexModel, CODEX_HIDDEN_MODELS } from "./config"
import type { AuthProvider } from "~/services/auth/types"

export { isHiddenCodexModel }

export interface ProviderModelOption {
    id: string
    label: string
}

const CODEX_MODELS: ProviderModelOption[] = [
    { id: "gpt-5.3-max-high", label: "Codex - 5.3 Max (High)" },
    { id: "gpt-5.3-max", label: "Codex - 5.3 Max" },
    { id: "gpt-5.3", label: "Codex - 5.3" },
    { id: "gpt-5.3-codex", label: "Codex - 5.3 Codex" },
    { id: "gpt-5.2-max-high", label: "Codex - 5.2 Max (High)" },
    { id: "gpt-5.2-max", label: "Codex - 5.2 Max" },
    { id: "gpt-5.2", label: "Codex - 5.2" },
    { id: "gpt-5.2-codex", label: "Codex - 5.2 Codex" },
    { id: "gpt-5.1", label: "Codex - 5.1" },
    { id: "gpt-5.1-codex", label: "Codex - 5.1 Codex" },
    { id: "gpt-5.1-codex-max", label: "Codex - 5.1 Codex Max" },
    { id: "gpt-5.1-codex-mini", label: "Codex - 5.1 Codex Mini" },
    { id: "gpt-5", label: "Codex - 5" },
    { id: "gpt-5-codex", label: "Codex - 5 Codex" },
    { id: "gpt-5-codex-mini", label: "Codex - 5 Codex Mini" },
]

const COPILOT_STATIC_MODELS: ProviderModelOption[] = [
    { id: "claude-opus-4-5-thinking", label: "Copilot - Opus 4.5 Thinking" },
    { id: "claude-sonnet-4-5", label: "Copilot - Sonnet 4.5" },
    { id: "claude-sonnet-4-5-thinking", label: "Copilot - Sonnet 4.5 Thinking" },
    { id: "gpt-4o", label: "Copilot - GPT-4o" },
    { id: "gpt-4o-mini", label: "Copilot - GPT-4o Mini" },
    { id: "gpt-4.1", label: "Copilot - GPT-4.1" },
    { id: "gpt-4.1-mini", label: "Copilot - GPT-4.1 Mini" },
]

const ZED_STATIC_MODELS: ProviderModelOption[] = []
// Grok：标准 ModelName grok-build 对应实际模型 Grok 4.3（对外标签 Xbuild）
const GROK_STATIC_MODELS: ProviderModelOption[] = [
    { id: "grok-build", label: "Xbuild" },
    { id: "grok-composer-2.5-fast", label: "Composer 2.5" },
]
const KIRO_STATIC_MODELS: ProviderModelOption[] = [
    { id: "auto", label: "Kiro - Auto" },
    { id: "claude-opus-4.7", label: "Kiro - Claude Opus 4.7" },
    { id: "claude-opus-4.6", label: "Kiro - Claude Opus 4.6" },
    { id: "claude-opus-4.5", label: "Kiro - Claude Opus 4.5" },
    { id: "claude-sonnet-4.6", label: "Kiro - Claude Sonnet 4.6" },
    { id: "claude-sonnet-4.5", label: "Kiro - Claude Sonnet 4.5" },
    { id: "claude-sonnet-4.0", label: "Kiro - Claude Sonnet 4.0" },
    { id: "claude-haiku-4.5", label: "Kiro - Claude Haiku 4.5" },
    { id: "glm-5", label: "Kiro - GLM-5" },
    { id: "deepseek-3.2", label: "Kiro - DeepSeek 3.2" },
    { id: "minimax-m2.5", label: "Kiro - MiniMax M2.5" },
    { id: "minimax-m2.1", label: "Kiro - MiniMax M2.1" },
    { id: "qwen3-coder-next", label: "Kiro - Qwen3 Coder Next" },
]

export function isInternalAntigravityModel(id: string): boolean {
    const lower = id.toLowerCase()
    return lower.startsWith("tab_") ||
        lower.startsWith("chat_") ||
        lower.includes("tiered") ||
        lower.includes("extra-low") ||
        lower.endsWith("-disabled")
}

interface ProviderModelStore {
    global: ProviderModelOption[]
    byAccount: Map<string, ProviderModelOption[]>
}

interface ProviderModelSpec {
    prefix: string
    getStaticModels: () => ProviderModelOption[]
    filter?: (model: ProviderModelOption) => boolean
    dynamicReplacesStatic?: boolean
    onUpdate?: () => void
}

const stores = new Map<AuthProvider, ProviderModelStore>()

function getStore(provider: AuthProvider): ProviderModelStore {
    let store = stores.get(provider)
    if (!store) {
        store = { global: [], byAccount: new Map() }
        stores.set(provider, store)
    }
    return store
}

function sanitizeModelOptions(
    models: ProviderModelOption[],
    prefix: string,
    filter?: (model: ProviderModelOption) => boolean
): ProviderModelOption[] {
    const deduped = new Map<string, ProviderModelOption>()

    for (const model of models || []) {
        const id = model?.id?.trim()
        if (!id || deduped.has(id)) continue

        const entry = { id, label: model?.label?.trim() || `${prefix} - ${id}` }
        if (filter && !filter(entry)) continue
        deduped.set(id, entry)
    }

    return Array.from(deduped.values())
}

function mergeModelOptions(...groups: ProviderModelOption[][]): ProviderModelOption[] {
    const merged = new Map<string, ProviderModelOption>()
    for (const group of groups) {
        for (const model of group) {
            if (!merged.has(model.id)) {
                merged.set(model.id, model)
            }
        }
    }
    return Array.from(merged.values())
}

function flattenDynamicModelsByAccount(bucket: Map<string, ProviderModelOption[]>): ProviderModelOption[] {
    return Array.from(bucket.values()).flat()
}

/** Feeds every discovered Antigravity model ID to the catalog, which resolves family/base aliases to the newest native ID. */
function syncAntigravityCatalog(): void {
    const store = getStore("antigravity")
    const discovered = mergeModelOptions(
        flattenDynamicModelsByAccount(store.byAccount),
        store.global
    )
    setDiscoveredAntigravityModelIds(discovered.map(m => m.id))
}

const PROVIDER_SPECS: Record<AuthProvider, ProviderModelSpec> = {
    antigravity: {
        prefix: "Antigravity",
        getStaticModels: () => [],
        filter: model => !isInternalAntigravityModel(model.id),
        onUpdate: syncAntigravityCatalog,
    },
    codex: {
        prefix: "Codex",
        getStaticModels: () => CODEX_MODELS.filter(model => !CODEX_HIDDEN_MODELS.has(model.id)),
        filter: model => !CODEX_HIDDEN_MODELS.has(model.id),
        dynamicReplacesStatic: true,
    },
    copilot: {
        prefix: "Copilot",
        getStaticModels: () => COPILOT_STATIC_MODELS,
    },
    zed: {
        prefix: "Zed",
        getStaticModels: () => ZED_STATIC_MODELS,
    },
    kiro: {
        prefix: "Kiro",
        getStaticModels: () => KIRO_STATIC_MODELS,
    },
    grok: {
        prefix: "Grok",
        getStaticModels: () => GROK_STATIC_MODELS,
    },
}

export function setDynamicProviderModels(provider: AuthProvider, models: ProviderModelOption[]): void {
    const spec = PROVIDER_SPECS[provider]
    const store = getStore(provider)
    store.global = sanitizeModelOptions(models, spec.prefix, spec.filter)
    spec.onUpdate?.()
}

export function clearDynamicProviderModels(provider: AuthProvider): void {
    const spec = PROVIDER_SPECS[provider]
    const store = getStore(provider)
    store.global = []
    store.byAccount.clear()
    spec.onUpdate?.()
}

export function setDynamicProviderModelsForAccount(provider: AuthProvider, accountId: string, models: ProviderModelOption[]): void {
    const id = accountId?.trim()
    if (!id) return
    const spec = PROVIDER_SPECS[provider]
    const store = getStore(provider)
    store.byAccount.set(id, sanitizeModelOptions(models, spec.prefix, spec.filter))
    spec.onUpdate?.()
}

export function clearDynamicProviderModelsForAccount(provider: AuthProvider, accountId: string): void {
    const spec = PROVIDER_SPECS[provider]
    getStore(provider).byAccount.delete(accountId)
    spec.onUpdate?.()
}

export function clearAllDynamicProviderModelsByAccount(provider: AuthProvider): void {
    const spec = PROVIDER_SPECS[provider]
    getStore(provider).byAccount.clear()
    spec.onUpdate?.()
}

export function getDynamicAntigravityModelIdsForAccount(accountId: string): string[] | undefined {
    const models = getStore("antigravity").byAccount.get(accountId)
    return models && models.length > 0 ? models.map(m => m.id) : undefined
}

function getCatalogAntigravityModels(): ProviderModelOption[] {
    const catalog = getAntigravityCatalog()
    return [...catalog.base, ...catalog.variants].map(m => ({ id: m.id, label: m.name }))
}

/** True for explicit effort/thinking variants such as `-high`, `-low`, `-medium` and `-thinking`. */
export function isVariantModelId(id: string): boolean {
    return /-(high|low|medium|thinking)$/.test(id)
}

/** Every known Antigravity model (catalog + discovered + static), with no per-family filtering. */
export function getAllAntigravityModels(): ProviderModelOption[] {
    const store = getStore("antigravity")
    const staticModels = getAvailableModels({ separateThinking: true, includeLegacy: true }).map(model => ({
        id: model.id,
        label: model.name,
    }))
    return mergeModelOptions(
        getCatalogAntigravityModels(),
        flattenDynamicModelsByAccount(store.byAccount),
        store.global,
        staticModels
    )
}

export const setDynamicCopilotModels = (models: ProviderModelOption[]) => setDynamicProviderModels("copilot", models)
export const clearDynamicCopilotModels = () => clearDynamicProviderModels("copilot")
export const setDynamicCopilotModelsForAccount = (accountId: string, models: ProviderModelOption[]) => setDynamicProviderModelsForAccount("copilot", accountId, models)
export const clearDynamicCopilotModelsForAccount = (accountId: string) => clearDynamicProviderModelsForAccount("copilot", accountId)
export const clearAllDynamicCopilotModelsByAccount = () => clearAllDynamicProviderModelsByAccount("copilot")

export const setDynamicCodexModels = (models: ProviderModelOption[]) => setDynamicProviderModels("codex", models)
export const clearDynamicCodexModels = () => clearDynamicProviderModels("codex")
export const setDynamicCodexModelsForAccount = (accountId: string, models: ProviderModelOption[]) => setDynamicProviderModelsForAccount("codex", accountId, models)
export const clearDynamicCodexModelsForAccount = (accountId: string) => clearDynamicProviderModelsForAccount("codex", accountId)
export const clearAllDynamicCodexModelsByAccount = () => clearAllDynamicProviderModelsByAccount("codex")

export const setDynamicAntigravityModels = (models: ProviderModelOption[]) => setDynamicProviderModels("antigravity", models)
export const clearDynamicAntigravityModels = () => clearDynamicProviderModels("antigravity")
export const setDynamicAntigravityModelsForAccount = (accountId: string, models: ProviderModelOption[]) => setDynamicProviderModelsForAccount("antigravity", accountId, models)
export const clearDynamicAntigravityModelsForAccount = (accountId: string) => clearDynamicProviderModelsForAccount("antigravity", accountId)
export const clearAllDynamicAntigravityModelsByAccount = () => clearAllDynamicProviderModelsByAccount("antigravity")

export const setDynamicZedModels = (models: ProviderModelOption[]) => setDynamicProviderModels("zed", models)
export const clearDynamicZedModels = () => clearDynamicProviderModels("zed")
export const setDynamicZedModelsForAccount = (accountId: string, models: ProviderModelOption[]) => setDynamicProviderModelsForAccount("zed", accountId, models)
export const clearDynamicZedModelsForAccount = (accountId: string) => clearDynamicProviderModelsForAccount("zed", accountId)
export const clearAllDynamicZedModelsByAccount = () => clearAllDynamicProviderModelsByAccount("zed")

export const setDynamicKiroModels = (models: ProviderModelOption[]) => setDynamicProviderModels("kiro", models)
export const clearDynamicKiroModels = () => clearDynamicProviderModels("kiro")
export const setDynamicKiroModelsForAccount = (accountId: string, models: ProviderModelOption[]) => setDynamicProviderModelsForAccount("kiro", accountId, models)
export const clearDynamicKiroModelsForAccount = (accountId: string) => clearDynamicProviderModelsForAccount("kiro", accountId)
export const clearAllDynamicKiroModelsByAccount = () => clearAllDynamicProviderModelsByAccount("kiro")

export const setDynamicGrokModels = (models: ProviderModelOption[]) => setDynamicProviderModels("grok", models)
export const clearDynamicGrokModels = () => clearDynamicProviderModels("grok")
export const setDynamicGrokModelsForAccount = (accountId: string, models: ProviderModelOption[]) => setDynamicProviderModelsForAccount("grok", accountId, models)
export const clearDynamicGrokModelsForAccount = (accountId: string) => clearDynamicProviderModelsForAccount("grok", accountId)
export const clearAllDynamicGrokModelsByAccount = () => clearAllDynamicProviderModelsByAccount("grok")

export function getProviderModels(
    provider: AuthProvider,
    options?: { includeAllVariants?: boolean }
): ProviderModelOption[] {
    if (provider === "antigravity") {
        const aliasModels = Array.from(getAntigravityCatalog().aliases.keys()).map(id => ({ id, label: id }))
        const all = mergeModelOptions(getAllAntigravityModels(), aliasModels)
        const separateThinking = options?.includeAllVariants ?? isSeparateThinkingModelsEnabled()
        return separateThinking ? all : all.filter(m => !isVariantModelId(m.id))
    }

    const spec = PROVIDER_SPECS[provider]
    if (!spec) return []

    const store = getStore(provider)
    const mergedDynamic = mergeModelOptions(
        flattenDynamicModelsByAccount(store.byAccount),
        store.global
    )

    if (spec.dynamicReplacesStatic) {
        return mergedDynamic.length > 0 ? mergedDynamic : spec.getStaticModels()
    }

    return mergeModelOptions(mergedDynamic, spec.getStaticModels())
}

export function getProviderModelsForAccount(provider: AuthProvider, accountId: string): ProviderModelOption[] {
    if (provider === "antigravity") {
        return getProviderModels(provider)
    }

    const spec = PROVIDER_SPECS[provider]
    if (!spec) return []

    const dynamic = getStore(provider).byAccount.get(accountId)
    if (dynamic && dynamic.length > 0) {
        return mergeModelOptions(dynamic, spec.getStaticModels())
    }
    return getProviderModels(provider)
}
