import { expect, test } from "bun:test"
import { AVAILABLE_MODELS } from "~/lib/config"
import { buildCatalog } from "~/lib/model-catalog"
import { getModelEnumValue, MODEL_ENUM } from "~/proto/encoder"
import { getProviderModels } from "~/services/routing/models"

const GEMINI_31_MODELS = [
    "gemini-3.1-pro-high",
    "gemini-3.1-pro-low",
    "gemini-3.1-flash-lite",
] as const

test("Gemini 3.1 models stay configured and routable as legacy Antigravity models", () => {
    const configuredIds = new Set(AVAILABLE_MODELS.map(model => model.id))
    const providerIds = new Set(getProviderModels("antigravity", { includeLegacy: true }).map(model => model.id))

    for (const model of GEMINI_31_MODELS) {
        expect(configuredIds.has(model)).toBe(true)
        expect(providerIds.has(model)).toBe(true)
    }
})

test("catalog keeps only the highest version of each family", () => {
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
    expect(catalog.selectedIds.has("claude-sonnet-4-6")).toBe(false)
    expect(catalog.selectedIds.has("gemini-3.1-flash-image")).toBe(false)
})

test("Gemini 3.1 models map to the corresponding Antigravity proto enums", () => {
    expect(getModelEnumValue("gemini-3.1-pro-high")).toBe(MODEL_ENUM.GEMINI_3_PRO_HIGH)
    expect(getModelEnumValue("gemini-3.1-pro-low")).toBe(MODEL_ENUM.GEMINI_3_PRO_LOW)
    expect(getModelEnumValue("gemini-3.1-flash")).toBe(MODEL_ENUM.GEMINI_3_FLASH)
    expect(getModelEnumValue("gemini-3.1-flash-lite")).toBe(MODEL_ENUM.GEMINI_3_FLASH)
})
