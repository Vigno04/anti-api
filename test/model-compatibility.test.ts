import { afterAll, expect, test } from "bun:test"
import { buildCatalog } from "~/lib/model-catalog"
import { getModelEnumValue, MODEL_ENUM } from "~/proto/encoder"
import { clearAllDynamicAntigravityModelsByAccount, clearDynamicAntigravityModels, getProviderModels, setDynamicAntigravityModels } from "~/services/routing/models"

test("catalog resolves family aliases to the highest version", () => {
    const catalog = buildCatalog([
        "claude-opus-5-5-high",
        "claude-opus-5-5-medium",
        "claude-opus-4-6-thinking",
        "claude-sonnet-5-5-high",
        "claude-sonnet-5-5-medium",
        "claude-sonnet-4-6",
        "gemini-pro-agent",
        "gemini-3.1-pro-high",
        "gemini-3.1-pro-low",
        "gemini-3-flash",
        "gemini-3.8-flash-medium",
        "gemini-3.8-flash-high",
        "gemini-3.5-flash-lite",
        "gemini-3.1-flash-lite",
        "gemini-3.1-flash-image",
        "gpt-oss-120b-medium",
    ])
    const baseIds = catalog.base.map(m => m.id).sort()
    expect(baseIds).toEqual([
        "claude-opus-5-5",
        "claude-sonnet-5-5",
        "gemini-3.1-pro",
        "gemini-3.5-flash-lite",
        "gemini-3.8-flash",
        "gpt-oss-120b",
    ])
    expect(catalog.aliases.get("claude-opus-5-5")).toBe("claude-opus-5-5-high")
    expect(catalog.aliases.get("claude-sonnet-5-5")).toBe("claude-sonnet-5-5-medium")
    expect(catalog.aliases.get("gemini-pro")).toBe("gemini-3.1-pro-high")
    expect(catalog.aliases.get("gemini-flash")).toBe("gemini-3.8-flash-medium")
})

test("Gemini 3.1 models map to the corresponding Antigravity proto enums", () => {
    expect(getModelEnumValue("gemini-3.1-pro-high")).toBe(MODEL_ENUM.GEMINI_3_PRO_HIGH)
    expect(getModelEnumValue("gemini-3.1-pro-low")).toBe(MODEL_ENUM.GEMINI_3_PRO_LOW)
    expect(getModelEnumValue("gemini-3.1-flash")).toBe(MODEL_ENUM.GEMINI_3_FLASH)
    expect(getModelEnumValue("gemini-3.1-flash-lite")).toBe(MODEL_ENUM.GEMINI_3_FLASH)
})

test("getProviderModels antigravity respects includeAllVariants flag", () => {
    clearAllDynamicAntigravityModelsByAccount()
    setDynamicAntigravityModels(
        ["claude-opus-5-5-high", "claude-opus-5-5-thinking", "claude-sonnet-5-5-medium", "gemini-4-argon-high", "gemini-3.8-flash-medium", "gpt-oss-120b-medium"]
            .map(id => ({ id, label: id }))
    )
    const baseModels = getProviderModels("antigravity", { includeAllVariants: false })
    const baseIds = baseModels.map(m => m.id)

    expect(baseIds).toContain("claude-opus-5-5")
    expect(baseIds).toContain("claude-sonnet-5-5")
    expect(baseIds).toContain("gemini-4-argon")
    expect(baseIds).toContain("gemini-3.8-flash")
    expect(baseIds).toContain("gpt-oss-120b")

    for (const id of baseIds) {
        expect(id.endsWith("-high")).toBe(false)
        expect(id.endsWith("-low")).toBe(false)
        expect(id.endsWith("-medium")).toBe(false)
        expect(id.endsWith("-thinking")).toBe(false)
    }

    const allModels = getProviderModels("antigravity", { includeAllVariants: true })
    const allIds = allModels.map(m => m.id)
    expect(allIds.some(id => id.endsWith("-high") || id.endsWith("-thinking"))).toBe(true)

    // Aliases and family shortcuts must never be exposed as distinct models in the catalog/UI
    const forbiddenAliases = ["gpt-oss", "claude-opus", "claude-sonnet", "gemini-argon", "argon", "gemini-flash"]
    for (const alias of forbiddenAliases) {
        expect(baseIds).not.toContain(alias)
        expect(allIds).not.toContain(alias)
    }
})

afterAll(() => {
    clearAllDynamicAntigravityModelsByAccount()
    clearDynamicAntigravityModels()
})
