/**
 * Anti-API 配置
 * Antigravity API端点和模型映射
 */

// 默认端口
export const DEFAULT_PORT = 8964

// Modelli ufficiali attivi (standard Antigravity CLI / agy)
export const BASE_OFFICIAL_MODELS = [
    { id: "gemini-4-argon", name: "Gemini 4 Argon" },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    { id: "gpt-oss-120b", name: "GPT-OSS 120B" },
]

// Varianti esplicite di thinking/effort supportate nativamente
export const THINKING_VARIANT_MODELS = [
    { id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
    { id: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
    { id: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)" },
    { id: "gemini-4-argon-thinking", name: "Gemini 4 Argon (Thinking)" },
    { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
    { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
    { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
    { id: "claude-opus-5-5-thinking", name: "Claude Opus 5.5 (Thinking)" },
    { id: "claude-sonnet-5-5-thinking", name: "Claude Sonnet 5.5 (Thinking)" },
    { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
]

// Modelli legacy per retrocompatibilità opzionale
export const LEGACY_OFFICIAL_MODELS = [
    { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
    { id: "claude-opus-4-5", name: "Claude Opus 4.5" },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { id: "claude-opus-4-5-thinking", name: "Claude Opus 4.5 (Thinking)" },
    { id: "claude-sonnet-4-5-thinking", name: "Claude Sonnet 4.5 (Thinking)" },
    { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
    { id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" },
    { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
    { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite" },
    { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite" },
    { id: "gemini-3-flash", name: "Gemini 3 Flash" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { id: "gemini-2.5-flash-thinking", name: "Gemini 2.5 Flash (Thinking)" },
]

export function getAvailableModels(options?: { separateThinking?: boolean; includeLegacy?: boolean }): Array<{ id: string; name: string }> {
    const list = options?.separateThinking
        ? [...BASE_OFFICIAL_MODELS, ...THINKING_VARIANT_MODELS]
        : [...BASE_OFFICIAL_MODELS]
    if (options?.includeLegacy) {
        return [...list, ...LEGACY_OFFICIAL_MODELS]
    }
    return list
}

// Retrocompatibilità (include legacy per routing e test)
export const AVAILABLE_MODELS = [...BASE_OFFICIAL_MODELS, ...THINKING_VARIANT_MODELS, ...LEGACY_OFFICIAL_MODELS]
