import consola from "consola"
import https from "https"
import { authStore } from "~/services/auth/store"
import { UpstreamError } from "~/lib/error"
import type { ProviderAccount } from "~/services/auth/types"
import type { ClaudeMessage, ClaudeTool } from "~/lib/translator"
import { toOpenAIMessages, toOpenAITools } from "~/services/providers/openai-adapter"
import { createAbortError, isAbortError, throwIfAborted } from "~/lib/stream-cancellation"
import { safeErrorMessage } from "~/lib/redaction"

const COPILOT_INSECURE_TLS = process.env.ANTI_API_COPILOT_INSECURE_TLS === "1"
const COPILOT_INSECURE_AGENT = COPILOT_INSECURE_TLS ? new https.Agent({ rejectUnauthorized: false }) : undefined

export function isCopilotInsecureTlsEnabled(): boolean {
    return COPILOT_INSECURE_TLS
}

const COPILOT_COMPLETIONS_URL = "https://api.githubcopilot.com/chat/completions"
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token"
const COPILOT_MODELS_URL = "https://api.githubcopilot.com/models"

interface CopilotTokenResponse {
    token: string
    expires_at?: number
}

/** Copilot advertises low/medium/high and, per model, none/xhigh/max. */
export type CopilotReasoningEffort = string

export interface CopilotModelInfo {
    id: string
    name?: string
    model_picker_enabled?: boolean
    vendor?: string
    policy?: { state?: string }
    supported_endpoints?: string[]
    capabilities?: {
        type?: string
        supports?: {
            reasoning_effort?: string[] | boolean
            tool_calls?: boolean
            streaming?: boolean
            vision?: boolean
        }
    }
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>()
const modelsCache = new Map<string, { models: CopilotModelInfo[]; expiresAt: number }>()

/** Models this account can actually use through chat/completions (what the Copilot picker shows). */
function normalizeCopilotModels(models: CopilotModelInfo[]): CopilotModelInfo[] {
    const deduped = new Map<string, CopilotModelInfo>()
    const hasPolicy = models.some(m => m?.policy?.state === "enabled")

    for (const model of models) {
        const id = model?.id?.trim()
        if (!id) continue
        // model_picker_enabled is unreliable (false for every model on some accounts): policy.state is what gates usage
        if (model.policy?.state === "disabled") continue
        if (hasPolicy && model.policy?.state !== "enabled") continue
        const type = model.capabilities?.type
        if (type && type !== "chat") continue
        if (model.supported_endpoints && model.supported_endpoints.length > 0
            && !model.supported_endpoints.includes("/chat/completions")) continue // /responses-only models are not callable here
        if (deduped.has(id)) continue

        deduped.set(id, {
            ...model,
            id,
        })
    }

    return Array.from(deduped.values())
}

/** Reasoning efforts advertised by Copilot for a model (empty when it has no effort control). */
export function getCopilotReasoningEfforts(model: CopilotModelInfo): CopilotReasoningEffort[] {
    const raw = model.capabilities?.supports?.reasoning_effort
    if (!Array.isArray(raw)) return []
    return raw.filter((e): e is string => typeof e === "string" && e !== "none")
}

const EFFORT_SUFFIX = /-(low|medium|high)$/

function modelKey(id: string): string {
    return id.trim().toLowerCase().replace(/[._]/g, "-")
}

/**
 * Resolves a requested id (e.g. `claude-sonnet-4-5`, `gpt-5.2-high`) to a model the account really has,
 * plus the reasoning effort encoded in the id. No hardcoded model table: the live /models list is the source of truth.
 */
export function resolveCopilotModel(
    available: CopilotModelInfo[],
    requested: string
): { id: string; effort?: CopilotReasoningEffort } {
    const lookup = (id: string) => {
        const exact = available.find(m => m.id === id)
        if (exact) return exact
        const key = modelKey(id)
        return available.find(m => modelKey(m.id) === key)
    }

    const direct = lookup(requested)
    if (direct) return { id: direct.id }

    const effortMatch = requested.match(EFFORT_SUFFIX)
    if (effortMatch) {
        const base = lookup(requested.replace(EFFORT_SUFFIX, ""))
        if (base) return { id: base.id, effort: effortMatch[1] }
    }

    // "-thinking" variants have no separate Copilot id: use the base model
    if (requested.endsWith("-thinking")) {
        const base = lookup(requested.slice(0, -"-thinking".length))
        if (base) return { id: base.id }
    }

    return { id: requested }
}
interface OpenAIResponse {
    choices: Array<{
        message?: { content?: string | null; tool_calls?: any[] }
        finish_reason?: string | null
    }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export async function createCopilotCompletion(
    account: ProviderAccount,
    model: string,
    messages: ClaudeMessage[],
    tools?: ClaudeTool[],
    maxTokens?: number,
    reasoningEffort?: CopilotReasoningEffort,
    signal?: AbortSignal
) {
    throwIfAborted(signal)
    const apiToken = await getCopilotApiToken(account, signal)

    const available = await fetchCopilotModels(apiToken, signal)
    throwIfAborted(signal)

    // Resolve against the account's real model list (cached, fetched online)
    const resolved = resolveCopilotModel(available, model)
    const mappedModel = resolved.id
    const info = available.find(m => m.id === mappedModel)
    const supported = info ? getCopilotReasoningEfforts(info) : []
    const effort = resolved.effort ?? reasoningEffort
    const effectiveEffort = effort && supported.includes(effort) ? effort : undefined

    const requestBody = {
        model: mappedModel,
        messages: toOpenAIMessages(messages),
        tools: toOpenAITools(tools),
        max_tokens: maxTokens,
        ...(effectiveEffort ? { reasoning_effort: effectiveEffort } : {}),
    }

    const response = await fetchInsecureJson(COPILOT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiToken}`,
            "User-Agent": "anti-api/1.0",
            "Editor-Version": "vscode/1.95.0",
            "Editor-Plugin-Version": "copilot/1.300.0",
        },
        body: JSON.stringify(requestBody),
        signal,
    })

    if (response.status < 200 || response.status >= 300) {
        consola.error(`Copilot error ${response.status} for model ${mappedModel}`)
        throw new UpstreamError("copilot", response.status, response.text, undefined)
    }

    const data = response.data as OpenAIResponse
    const choice = data?.choices?.[0]
    const content = choice?.message?.content || ""
    const toolCalls = choice?.message?.tool_calls || []

    const contentBlocks = []
    if (toolCalls.length > 0) {
        for (const call of toolCalls) {
            contentBlocks.push({
                type: "tool_use" as const,
                id: call.id || `tool_${crypto.randomUUID().slice(0, 8)}`,
                name: call.function?.name || "tool",
                input: safeParse(call.function?.arguments),
            })
        }
    }
    if (content) {
        contentBlocks.push({ type: "text" as const, text: content })
    }

    authStore.markSuccess("copilot", account.id)

    return {
        contentBlocks,
        stopReason: toolCalls.length > 0 ? "tool_use" : mapFinishReason(choice?.finish_reason),
        usage: {
            inputTokens: data.usage?.prompt_tokens || 0,
            outputTokens: data.usage?.completion_tokens || 0,
        },
    }
}

export async function listCopilotModelsForAccount(account: ProviderAccount, signal?: AbortSignal): Promise<CopilotModelInfo[]> {
    const apiToken = await getCopilotApiToken(account, signal)
    return fetchCopilotModels(apiToken, signal)
}

async function getCopilotApiToken(account: ProviderAccount, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal)
    const cached = tokenCache.get(account.id)
    if (cached && cached.expiresAt > Date.now()) {
        return cached.token
    }

    const response = await fetchInsecureJson(COPILOT_TOKEN_URL, {
        method: "GET",
        headers: {
            Authorization: `Bearer ${account.accessToken}`,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        signal,
    })

    const data = response.data as CopilotTokenResponse
    if (response.status < 200 || response.status >= 300 || !data?.token) {
        throw new Error(`copilot:token:${response.status}`)
    }

    const expiresAt = data.expires_at ? data.expires_at * 1000 : Date.now() + 10 * 60 * 1000
    tokenCache.set(account.id, { token: data.token, expiresAt })
    return data.token
}

function safeParse(value: string | undefined): any {
    if (!value) return {}
    try {
        return JSON.parse(value)
    } catch (error) {
        consola.warn("Copilot tool args parse failed:", safeErrorMessage(error))
        return {}
    }
}

function mapFinishReason(reason?: string | null): string {
    if (!reason || reason === "stop") return "end_turn"
    if (reason === "length") return "max_tokens"
    if (reason === "tool_calls") return "tool_use"
    return reason
}

async function fetchCopilotModels(apiToken: string, signal?: AbortSignal): Promise<CopilotModelInfo[]> {
    throwIfAborted(signal)
    const cached = modelsCache.get(apiToken)
    if (cached && cached.expiresAt > Date.now()) {
        return cached.models
    }

    try {
        const response = await fetchInsecureJson(COPILOT_MODELS_URL, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${apiToken}`,
                "Accept": "application/json",
                "User-Agent": "GithubCopilot/1.0",
                "Editor-Version": "vscode/1.100.0",
                "Editor-Plugin-Version": "copilot/1.300.0",
            },
            signal,
        })

        if (response.status < 200 || response.status >= 300) {
            consola.warn("Failed to fetch Copilot models:", response.status)
            return []
        }

        const data = response.data as { data: CopilotModelInfo[] }
        const models = normalizeCopilotModels(data?.data || [])

        modelsCache.set(apiToken, { models, expiresAt: Date.now() + 5 * 60 * 1000 })
        return models
    } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
            throw createAbortError()
        }
        consola.warn("Error fetching Copilot models:", safeErrorMessage(error))
        return []
    }
}

// Insecure JSON fetch using Node.js https module to bypass TLS certificate errors
type InsecureResponse = { status: number; data: any; text: string }

async function fetchInsecureJson(
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
): Promise<InsecureResponse> {
    throwIfAborted(options.signal)
    const target = new URL(url)
    const method = options.method || "GET"
    const headers = {
        "User-Agent": "anti-api/1.0",
        ...(options.headers || {}),
    }
    const agent = COPILOT_INSECURE_AGENT

    return new Promise((resolve, reject) => {
        let settled = false
        let req: ReturnType<typeof https.request>
        const cleanup = () => options.signal?.removeEventListener("abort", onAbort)
        const resolveOnce = (value: InsecureResponse) => {
            if (settled) return
            settled = true
            cleanup()
            resolve(value)
        }
        const rejectOnce = (error: unknown) => {
            if (settled) return
            settled = true
            cleanup()
            reject(error)
        }
        const onAbort = () => {
            if (settled) return
            req?.destroy()
            rejectOnce(createAbortError())
        }

        req = https.request(
            {
                protocol: target.protocol,
                hostname: target.hostname,
                port: target.port || 443,
                path: `${target.pathname}${target.search}`,
                method,
                headers,
                agent,
                rejectUnauthorized: agent ? false : true,
                timeout: 30000,
            },
            (res) => {
                let body = ""
                res.on("data", (chunk) => {
                    body += chunk
                })
                res.on("end", () => {
                    let data: any = null
                    if (body) {
                        try {
                            data = JSON.parse(body)
                        } catch {
                            data = null
                        }
                    }
                    resolveOnce({
                        status: res.statusCode || 0,
                        data,
                        text: body,
                    })
                })
            }
        )

        req.on("error", (error) => {
            if (options.signal?.aborted || isAbortError(error)) {
                rejectOnce(createAbortError())
                return
            }
            if (!COPILOT_INSECURE_TLS && /certificate|self signed/i.test(error.message)) {
                rejectOnce(new Error("Copilot TLS certificate error. Set ANTI_API_COPILOT_INSECURE_TLS=1 to bypass."))
                return
            }
            rejectOnce(error)
        })
        req.on("timeout", () => {
            req.destroy(new Error("Request timed out"))
        })

        if (options.signal) {
            if (options.signal.aborted) {
                onAbort()
                return
            }
            options.signal.addEventListener("abort", onAbort, { once: true })
        }

        if (options.body) {
            req.write(options.body)
        }
        req.end()
    })
}
