/**
 * Anti-API 配置
 * Antigravity API端点和模型映射
 */

// 默认端口
export const DEFAULT_PORT = 8964

// Modelli puliti/unificati (standard OpenAI con supporto a reasoning_effort)
export const BASE_OFFICIAL_MODELS = [
    { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "gemini-4-argon", name: "Gemini 4 Argon" },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
    { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
    { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite" },
    { id: "gpt-oss-120b", name: "GPT-OSS 120B" },
    // Versioni precedenti / legacy per compatibilità
    { id: "claude-opus-4-5", name: "Claude Opus 4.5" },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { id: "gemini-3-flash", name: "Gemini 3 Flash" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite" },
]

// Varianti esplicite di thinking
export const THINKING_VARIANT_MODELS = [
    { id: "claude-opus-5-5-thinking", name: "Claude Opus 5.5 (Thinking)" },
    { id: "claude-sonnet-5-5-thinking", name: "Claude Sonnet 5.5 (Thinking)" },
    { id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
    { id: "gemini-4-argon-thinking", name: "Gemini 4 Argon (Thinking)" },
    { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
    { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
    { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
    { id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" },
    { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
    { id: "gemini-3-pro-high", name: "Gemini 3 Pro (High)" },
    { id: "gemini-3-pro-low", name: "Gemini 3 Pro (Low)" },
    { id: "gemini-2.5-flash-thinking", name: "Gemini 2.5 Flash (Thinking)" },
    { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
    { id: "claude-opus-4-5-thinking", name: "Claude Opus 4.5 (Thinking)" },
    { id: "claude-sonnet-4-5-thinking", name: "Claude Sonnet 4.5 (Thinking)" },
]

export function getAvailableModels(options?: { separateThinking?: boolean }): Array<{ id: string; name: string }> {
    if (options?.separateThinking) {
        return [...BASE_OFFICIAL_MODELS, ...THINKING_VARIANT_MODELS]
    }
    return BASE_OFFICIAL_MODELS
}

// Retrocompatibilità
export const AVAILABLE_MODELS = [...BASE_OFFICIAL_MODELS, ...THINKING_VARIANT_MODELS]
