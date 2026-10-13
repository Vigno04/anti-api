import { expect, test } from "bun:test"
import { buildAntigravityParts, buildGenerationConfig, claudeToAntigravity, getAntigravityModelName } from "~/services/antigravity/chat"

test("Gemini 3.1 generation config omits legacy safety settings and caps output", async () => {
    expect(buildGenerationConfig("gemini-3.1-pro-low", 100000)).toEqual({ maxOutputTokens: 65536 })
    const request = await claudeToAntigravity("gemini-3.1-pro-low", [{ role: "user", content: "hello" }], undefined, undefined, 100000)
    expect(request.request.generationConfig).toEqual({ maxOutputTokens: 65536 })
    expect(request.request.safetySettings).toBeUndefined()
})

test("Gemini 3.1 aliases resolve to current native Antigravity model IDs", async () => {
    expect(getAntigravityModelName("gemini-3.1-pro-high")).toBe("gemini-pro-agent")
    expect(getAntigravityModelName("gemini-3.1-flash")).toBe("gemini-3.1-flash")

    const request = await claudeToAntigravity(
        getAntigravityModelName("gemini-3.1-pro-high"),
        [{ role: "user", content: "hello" }],
        undefined,
        undefined,
        100000,
    )
    expect(request.model).toBe("gemini-pro-agent")
    expect(request.request.generationConfig).toEqual({ maxOutputTokens: 65536 })
    expect(request.request.safetySettings).toBeUndefined()
})

test("Antigravity request builder emits inline data for image blocks", async () => {
    const parts = await buildAntigravityParts([
        { type: "text", text: "what is this?" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
    ], new Map())

    expect(parts).toEqual([
        { text: "what is this?" },
        { inlineData: { mimeType: "image/png", data: "AQID" } },
    ])
})

test("Gemini models attach tools and use AUTO function calling mode", async () => {
    const tools = [{
        name: "terminal",
        description: "Run shell command",
        input_schema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"]
        }
    }]

    const request = await claudeToAntigravity(
        "gemini-3.8-flash-medium",
        [{ role: "user", content: "update servers" }],
        tools
    )

    expect(request.request.tools).toBeDefined()
    expect(request.request.tools.length).toBe(1)
    expect(request.request.tools[0].functionDeclarations[0].name).toBe("terminal")
    expect(request.request.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } })
})

test("Gemini models with specific tool choice use ANY mode with allowed function names", async () => {
    const tools = [{
        name: "terminal",
        description: "Run shell command",
        input_schema: { type: "object", properties: {} }
    }]

    const request = await claudeToAntigravity(
        "gemini-3.8-flash-medium",
        [{ role: "user", content: "run command" }],
        tools,
        { type: "tool", name: "terminal" }
    )

    expect(request.request.toolConfig).toEqual({
        functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["terminal"] }
    })
})

test("Claude models attach tools and use VALIDATED function calling mode", async () => {
    const tools = [{
        name: "search",
        description: "Search web",
        input_schema: { type: "object", properties: {} }
    }]

    const request = await claudeToAntigravity(
        "claude-sonnet-4-5",
        [{ role: "user", content: "search web" }],
        tools
    )

    expect(request.request.tools).toBeDefined()
    expect(request.request.tools[0].functionDeclarations[0].name).toBe("search")
    expect(request.request.toolConfig).toEqual({ functionCallingConfig: { mode: "VALIDATED" } })
})

test("Gemini models without tools omit toolConfig", async () => {
    const request = await claudeToAntigravity(
        "gemini-3.8-flash-medium",
        [{ role: "user", content: "hello" }]
    )

    expect(request.request.tools).toBeUndefined()
    expect(request.request.toolConfig).toBeUndefined()
})
