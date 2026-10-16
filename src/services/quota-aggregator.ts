import consola from "consola"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { authStore } from "~/services/auth/store"
import { refreshAccessToken } from "~/services/antigravity/oauth"
import {
    fetchAntigravityModels as fetchAntigravityModelsRequest,
    fetchAntigravityQuotaSummary,
    type AntigravityModelInfo,
    type AntigravityQuotaSummaryResponse,
    type AntigravityQuotaBucket,
    type AntigravityQuotaGroup,
} from "~/services/antigravity/quota-fetch"
import { refreshCodexAccessToken, refreshCodexAccountIfNeeded } from "~/services/codex/oauth"
import { accountManager } from "~/services/antigravity/account-manager"
import type { ProviderAccount } from "~/services/auth/types"
import { UpstreamError } from "~/lib/error"
import { getDataDir } from "~/lib/data-dir"
import { fetchZedAccountOverview } from "~/services/zed/chat"
import { safeErrorMessage } from "~/lib/redaction"

type ModelInfo = AntigravityModelInfo

type AccountBar = {
    key: string
    label: string
    percentage: number
    resetTime?: string
    disabled?: boolean
}

type QuotaProvider = "antigravity" | "codex" | "copilot" | "zed" | "kiro"

export type AccountQuotaView = {
    provider: QuotaProvider
    accountId: string
    displayName: string
    bars: AccountBar[]
    proxy?: string
    label?: string
}

type QuotaCacheEntry = {
    provider: QuotaProvider
    accountId: string
    displayName: string
    bars: AccountBar[]
    updatedAt: string
    proxy?: string
    label?: string
}

const QUOTA_CACHE_DIR = getDataDir()
const QUOTA_CACHE_FILE = join(QUOTA_CACHE_DIR, "quota-cache.json")
let quotaCache = new Map<string, QuotaCacheEntry>()
let cacheLoaded = false
const PROVIDER_FETCH_TIMEOUT_MS = 4000

function getCacheKey(provider: QuotaCacheEntry["provider"], accountId: string): string {
    return `${provider}:${accountId}`
}

function loadQuotaCache(): void {
    if (cacheLoaded) return
    cacheLoaded = true
    try {
        if (!existsSync(QUOTA_CACHE_FILE)) return
        const raw = JSON.parse(readFileSync(QUOTA_CACHE_FILE, "utf-8")) as Record<string, QuotaCacheEntry>
        quotaCache = new Map(Object.entries(raw))
    } catch {
        quotaCache = new Map()
    }
}

function saveQuotaCache(): void {
    try {
        if (!existsSync(QUOTA_CACHE_DIR)) {
            mkdirSync(QUOTA_CACHE_DIR, { recursive: true })
        }
        const payload: Record<string, QuotaCacheEntry> = {}
        for (const [key, value] of quotaCache.entries()) {
            payload[key] = value
        }
        writeFileSync(QUOTA_CACHE_FILE, JSON.stringify(payload, null, 2))
    } catch {
        // Best-effort cache only
    }
}

function updateQuotaCache(entry: QuotaCacheEntry): void {
    quotaCache.set(getCacheKey(entry.provider, entry.accountId), entry)
}

function getCachedBars(provider: QuotaCacheEntry["provider"], accountId: string): AccountBar[] | null {
    const cached = quotaCache.get(getCacheKey(provider, accountId))
    return cached?.bars || null
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: () => T, label: string): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return promise
    }
    return new Promise(resolve => {
        let settled = false
        const timer = setTimeout(() => {
            if (settled) return
            settled = true
            consola.warn(`${label} quota fetch timed out after ${timeoutMs}ms, using cached data`)
            resolve(fallback())
        }, timeoutMs)
        promise.then(result => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(result)
        }).catch(error => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            consola.warn(`${label} quota fetch failed, using cached data:`, safeErrorMessage(error))
            resolve(fallback())
        })
    })
}

function defaultCodexBars(): AccountBar[] {
    return [
        { key: "session", label: "5h", percentage: 0 },
        { key: "week", label: "week", percentage: 0 },
    ]
}

function defaultCopilotBars(): AccountBar[] {
    return [{ key: "premium", label: "premium", percentage: 0 }]
}

function defaultZedBars(): AccountBar[] {
    return [{ key: "hosted", label: "hosted", percentage: 0 }]
}

function defaultKiroBars(): AccountBar[] {
    return [{ key: "access", label: "access", percentage: 100 }]
}

function buildCachedViews(provider: QuotaCacheEntry["provider"], accounts: ProviderAccount[]): AccountQuotaView[] {
    return accounts.map(account => {
        const displayName = account.label || account.email || account.login || account.id
        const cachedBars = getCachedBars(provider, account.id)
        const bars = cachedBars || (
            provider === "antigravity"
                ? buildAntigravityBars({})
                : provider === "codex"
                    ? defaultCodexBars()
                    : provider === "copilot"
                        ? defaultCopilotBars()
                        : provider === "zed"
                            ? defaultZedBars()
                            : defaultKiroBars()
        )
        return {
            provider,
            accountId: account.id,
            displayName,
            bars,
            proxy: account.proxy,
            label: account.label,
        }
    })
}

export async function getAggregatedQuota(): Promise<{
    timestamp: string
    accounts: AccountQuotaView[]
}> {
    loadQuotaCache()
    accountManager.load()

    const antigravityAccounts = authStore.listAccounts("antigravity")
    const codexAccounts = authStore.listAccounts("codex")
    const copilotAccounts = authStore.listAccounts("copilot")
    const zedAccounts = authStore.listAccounts("zed")
    const kiroAccounts = authStore.listAccounts("kiro")

    const [antigravity, codex, copilot, zed, kiro] = await Promise.all([
        withTimeout(
            fetchAntigravityQuotas(antigravityAccounts),
            PROVIDER_FETCH_TIMEOUT_MS,
            () => buildCachedViews("antigravity", antigravityAccounts),
            "Antigravity",
        ),
        withTimeout(
            fetchCodexQuotas(codexAccounts),
            PROVIDER_FETCH_TIMEOUT_MS,
            () => buildCachedViews("codex", codexAccounts),
            "Codex",
        ),
        withTimeout(
            fetchCopilotQuotas(copilotAccounts),
            PROVIDER_FETCH_TIMEOUT_MS,
            () => buildCachedViews("copilot", copilotAccounts),
            "Copilot",
        ),
        withTimeout(
            fetchZedQuotas(zedAccounts),
            PROVIDER_FETCH_TIMEOUT_MS,
            () => buildCachedViews("zed", zedAccounts),
            "Zed",
        ),
        withTimeout(
            fetchKiroQuotas(kiroAccounts),
            PROVIDER_FETCH_TIMEOUT_MS,
            () => buildCachedViews("kiro", kiroAccounts),
            "Kiro",
        ),
    ])
    saveQuotaCache()

    return {
        timestamp: new Date().toISOString(),
        accounts: [...antigravity, ...codex, ...copilot, ...zed, ...kiro],
    }
}

async function fetchAntigravityQuotas(accounts: ProviderAccount[]): Promise<AccountQuotaView[]> {
    // Fetch all accounts in parallel for faster loading
    const promises = accounts.map(async (account) => {
        let lastError: Error | null = null

        // Retry up to 2 times for each account
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const refreshed = await refreshAntigravityToken(account)
                const quotaModels = await fetchAntigravityModelsForAccount(refreshed).catch(() => ({}))
                const quotaSummary = await fetchAntigravityQuotaSummaryForAccount(refreshed)
                const bars = buildAntigravityBars(quotaModels, quotaSummary)
                const displayName = account.label || account.email || account.id
                updateQuotaCache({
                    provider: "antigravity",
                    accountId: account.id,
                    displayName,
                    bars,
                    updatedAt: new Date().toISOString(),
                    proxy: account.proxy,
                    label: account.label,
                })
                return {
                    provider: "antigravity" as const,
                    accountId: account.id,
                    displayName,
                    bars,
                    proxy: account.proxy,
                    label: account.label,
                }
            } catch (error) {
                lastError = error as Error
                if (attempt < 1) {
                    // Wait 500ms before retry (reduced from 1000ms)
                    await new Promise(resolve => setTimeout(resolve, 500))
                }
            }
        }

        if (lastError) {
            if (!isCertificateError(lastError) && !isAuthError(lastError)) {
                consola.warn("Antigravity quota fetch failed:", safeErrorMessage(lastError))
            }
        }
        const cachedBars = getCachedBars("antigravity", account.id)
        const displayName = account.label || account.email || account.id
        if (cachedBars) {
            return {
                provider: "antigravity" as const,
                accountId: account.id,
                displayName,
                bars: cachedBars,
                proxy: account.proxy,
                label: account.label,
            }
        }
        return {
            provider: "antigravity" as const,
            accountId: account.id,
            displayName,
            bars: buildAntigravityBars({}),
            proxy: account.proxy,
            label: account.label,
        }
    })

    return Promise.all(promises)
}

async function refreshAntigravityToken(account: ProviderAccount): Promise<ProviderAccount> {
    if (!account.refreshToken) {
        return account
    }
    if (!account.expiresAt || account.expiresAt > Date.now() + 60_000) {
        return account
    }

    try {
        const refreshed = await refreshAccessToken(account.refreshToken, account.proxy)
        const updated = {
            ...account,
            accessToken: refreshed.accessToken,
            expiresAt: Date.now() + refreshed.expiresIn * 1000,
        }
        authStore.saveAccount(updated)
        return updated
    } catch (error) {
        if (isCertificateError(error) || isAuthError(error)) {
            const updated = {
                ...account,
                expiresAt: 0,
            }
            authStore.saveAccount(updated)
            return updated
        }
        throw error
    }
}

async function fetchAntigravityModelsForAccount(
    account: ProviderAccount,
    hasRefreshed = false
): Promise<Record<string, ModelInfo>> {
    try {
        const result = await fetchAntigravityModelsRequest(account.accessToken, account.projectId, account.proxy)
        if (!account.projectId && result.projectId) {
            account.projectId = result.projectId
            authStore.saveAccount(account)
        }
        return result.models
    } catch (error) {
        if (error instanceof UpstreamError && error.status === 401 && account.refreshToken && !hasRefreshed) {
            try {
                const refreshed = await refreshAccessToken(account.refreshToken, account.proxy)
                account.accessToken = refreshed.accessToken
                account.expiresAt = Date.now() + refreshed.expiresIn * 1000
                authStore.saveAccount(account)
                return fetchAntigravityModelsForAccount(account, true)
            } catch (refreshError) {
                if (isCertificateError(refreshError) || isAuthError(refreshError)) {
                    return {}
                }
                throw refreshError
            }
        }

        if (error instanceof UpstreamError && error.status === 401) {
            return {}
        }

        throw error
    }
}

async function fetchAntigravityQuotaSummaryForAccount(
    account: ProviderAccount,
    hasRefreshed = false
): Promise<AntigravityQuotaSummaryResponse | null> {
    try {
        return await fetchAntigravityQuotaSummary(account.accessToken, account.projectId, account.proxy)
    } catch (error) {
        if (error instanceof UpstreamError && error.status === 401 && account.refreshToken && !hasRefreshed) {
            try {
                const refreshed = await refreshAccessToken(account.refreshToken, account.proxy)
                account.accessToken = refreshed.accessToken
                account.expiresAt = Date.now() + refreshed.expiresIn * 1000
                authStore.saveAccount(account)
                return fetchAntigravityQuotaSummaryForAccount(account, true)
            } catch (refreshError) {
                if (isCertificateError(refreshError) || isAuthError(refreshError)) {
                    return null
                }
                throw refreshError
            }
        }

        if (error instanceof UpstreamError && error.status === 401) {
            return null
        }

        return null
    }
}

export function buildAntigravityBars(
    models: Record<string, ModelInfo>,
    summary?: AntigravityQuotaSummaryResponse | null
): AccountBar[] {
    if (summary?.groups && summary.groups.length > 0) {
        const groups = summary.groups

        const geminiGroup = groups.find(g => {
            const name = (g.displayName || "").toLowerCase()
            return name.includes("gemini") && !name.includes("argon")
        }) || groups.find(g => (g.buckets || []).some(b => {
            const id = b.bucketId.toLowerCase()
            const d = (b.displayName || "").toLowerCase()
            return (id.includes("gemini") || d.includes("gemini")) && !id.includes("argon") && !d.includes("argon")
        }))

        const claudeGroup = groups.find(g => {
            const name = (g.displayName || "").toLowerCase()
            return name.includes("claude") || name.includes("gpt") || name.includes("3p")
        }) || groups.find(g => (g.buckets || []).some(b => {
            const id = b.bucketId.toLowerCase()
            return id.includes("3p") || id.includes("claude") || id.includes("gpt")
        }))

        const argonGroup = groups.find(g => {
            const name = (g.displayName || "").toLowerCase()
            return name.includes("argon")
        }) || groups.find(g => (g.buckets || []).some(b => {
            const id = b.bucketId.toLowerCase()
            const d = (b.displayName || "").toLowerCase()
            return id.includes("argon") || d.includes("argon")
        }))

        const allBuckets = groups.flatMap(g => g.buckets || [])

        const getBucket = (group: AntigravityQuotaGroup | undefined, isWeekly: boolean, filterArgon = false) => {
            const buckets = group?.buckets || []
            return buckets.find(b => {
                const w = (b.window || "").toLowerCase()
                const id = b.bucketId.toLowerCase()
                const d = (b.displayName || "").toLowerCase()
                if (filterArgon && (id.includes("argon") || d.includes("argon"))) return false
                return isWeekly ? (w === "weekly" || id.includes("week")) : (w === "5h" || id.includes("5h"))
            })
        }

        const isArgonBucket = (b: AntigravityQuotaBucket) => {
            const id = (b.bucketId || "").toLowerCase()
            const d = (b.displayName || "").toLowerCase()
            return id.includes("argon") || d.includes("argon")
        }

        const getArgonBucket = (isWeekly: boolean) => {
            const isDedicatedArgonGroup = Boolean(argonGroup && (argonGroup.displayName || "").toLowerCase().includes("argon"))
            const candidateBuckets = isDedicatedArgonGroup
                ? (argonGroup?.buckets || [])
                : allBuckets.filter(isArgonBucket)

            return candidateBuckets.find(b => {
                if (!isDedicatedArgonGroup && !isArgonBucket(b)) return false
                const w = (b.window || "").toLowerCase()
                const id = b.bucketId.toLowerCase()
                return isWeekly ? (w === "weekly" || id.includes("week") || !id.includes("5h")) : (w === "5h" || id.includes("5h"))
            })
        }

        const gWeekly = getBucket(geminiGroup, true, true)
        const g5h = getBucket(geminiGroup, false, true)
        const cWeekly = getBucket(claudeGroup, true)
        const c5h = getBucket(claudeGroup, false)
        const aWeekly = getArgonBucket(true)
        const a5h = getArgonBucket(false)

        const toBar = (key: string, label: string, bucket?: AntigravityQuotaBucket, defaultPct = 100): AccountBar => {
            if (!bucket) {
                return { key, label, percentage: defaultPct }
            }
            const fraction = typeof bucket.remainingFraction === "number" ? bucket.remainingFraction : (defaultPct / 100)
            const percentage = Math.max(0, Math.min(100, Math.round(fraction * 100)))
            return {
                key,
                label,
                percentage,
                resetTime: bucket.resetTime || undefined,
                ...(bucket.disabled !== undefined ? { disabled: bucket.disabled } : {}),
            }
        }

        const result: AccountBar[] = [
            toBar("gemini_week", "weekly gemini", gWeekly, 100),
            toBar("gemini_5h", "5hr gemini", g5h, 100),
            toBar("claude_gpt_week", "weekly claude gpt", cWeekly, 0),
            toBar("claude_gpt_5h", "5hr claude gpt", c5h, 0),
            toBar("argon_week", "weekly argon", aWeekly, 0),
        ]

        if (a5h) {
            result.push(toBar("argon_5h", "5hr argon", a5h, 0))
        }

        return result
    }

    const argonIds = [
        "gemini-4-argon",
        "gemini-4-argon-high",
        "gemini-4-argon-medium",
        "gemini-4-argon-low",
        "gemini-4-argon-thinking",
        "gemini-argon",
        "gemini-argon-high",
        "gemini-argon-medium",
        "gemini-argon-low",
        "gemini-argon-thinking",
    ]
    const claudeGptIds = [
        "claude-opus-5-5",
        "claude-opus-5-5-high",
        "claude-opus-5-5-medium",
        "claude-opus-5-5-low",
        "claude-opus-5-5-thinking",
        "claude-sonnet-5-5",
        "claude-sonnet-5-5-high",
        "claude-sonnet-5-5-medium",
        "claude-sonnet-5-5-low",
        "claude-sonnet-5-5-thinking",
        "claude-opus-4-6-thinking",
        "claude-sonnet-4-6",
        "claude-opus-4-5-thinking",
        "claude-sonnet-4-5",
        "claude-sonnet-4-5-thinking",
        "gpt-oss-120b",
        "gpt-oss-120b-medium",
    ]
    const geminiIds = [
        "gemini-pro-agent",
        "gemini-3.1-pro-high",
        "gemini-3.1-pro-low",
        "gemini-3.1-pro",
        "gemini-pro",
        "gemini-3-pro-high",
        "gemini-3-pro-low",
        "gemini-3.8-flash-high",
        "gemini-3.8-flash-medium",
        "gemini-3.8-flash-low",
        "gemini-3.8-flash",
        "gemini-3.7-flash-high",
        "gemini-3.7-flash-medium",
        "gemini-3.7-flash-low",
        "gemini-3.6-flash-high",
        "gemini-3.6-flash-medium",
        "gemini-3.6-flash-low",
        "gemini-3.5-flash-lite",
        "gemini-3.5-flash-low",
        "gemini-3.5-flash-extra-low",
        "gemini-3.1-flash",
        "gemini-3.1-flash-lite",
        "gemini-3-flash",
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",
        "gemini-2.5-flash-thinking",
        "gemini-flash",
    ]

    const geminiRaw = buildMergedBar("gemini", "gemini", models, geminiIds)
    const claudeGptRaw = buildMergedBar("claude_gpt", "claude_gpt", models, claudeGptIds)
    const argonRaw = buildMergedBar("argon", "argon", models, argonIds)

    const now = Date.now()
    const isGeminiWeekly = geminiRaw.resetTime ? (Date.parse(geminiRaw.resetTime) - now > 12 * 3600 * 1000) : false
    const isClaudeWeekly = claudeGptRaw.resetTime ? (Date.parse(claudeGptRaw.resetTime) - now > 12 * 3600 * 1000) : true
    const hasArgonModels = argonIds.some(id => Boolean(models[id]))

    const geminiWeekly: AccountBar = {
        key: "gemini_week",
        label: "weekly gemini",
        percentage: isGeminiWeekly ? geminiRaw.percentage : 100,
        resetTime: isGeminiWeekly ? geminiRaw.resetTime : undefined,
    }
    const gemini5h: AccountBar = {
        key: "gemini_5h",
        label: "5hr gemini",
        percentage: isGeminiWeekly ? 0 : geminiRaw.percentage,
        resetTime: isGeminiWeekly ? undefined : geminiRaw.resetTime,
    }
    const claudeGptWeekly: AccountBar = {
        key: "claude_gpt_week",
        label: "weekly claude gpt",
        percentage: isClaudeWeekly ? claudeGptRaw.percentage : 100,
        resetTime: isClaudeWeekly ? claudeGptRaw.resetTime : undefined,
    }
    const claudeGpt5h: AccountBar = {
        key: "claude_gpt_5h",
        label: "5hr claude gpt",
        percentage: !isClaudeWeekly ? claudeGptRaw.percentage : (claudeGptRaw.percentage <= 0 ? 0 : 100),
        resetTime: !isClaudeWeekly ? claudeGptRaw.resetTime : undefined,
    }
    const argonWeekly: AccountBar = {
        key: "argon_week",
        label: "weekly argon",
        percentage: hasArgonModels ? argonRaw.percentage : 0,
        resetTime: hasArgonModels ? argonRaw.resetTime : undefined,
    }

    return [
        geminiWeekly,
        gemini5h,
        claudeGptWeekly,
        claudeGpt5h,
        argonWeekly,
    ]
}

function buildMergedBar(
    key: string,
    label: string,
    models: Record<string, ModelInfo>,
    ids: string[]
): AccountBar {
    const entries = ids
        .map(id => models[id])
        .filter(Boolean)

    if (entries.length === 0) {
        return { key, label, percentage: 100 }
    }

    const percentages = entries.map(item => Math.round((item?.remainingFraction ?? 0) * 100))
    const percentage = Math.min(...percentages)
    const resetTime = earliestResetTime(entries.map(item => item?.resetTime).filter(Boolean) as string[])
    return { key, label, percentage, resetTime }
}

function earliestResetTime(times: string[]): string | undefined {
    if (times.length === 0) return undefined
    return times.reduce((earliest, current) => {
        if (!earliest) return current
        return new Date(current).getTime() < new Date(earliest).getTime() ? current : earliest
    }, times[0])
}

async function fetchCodexQuotas(accounts: ProviderAccount[]): Promise<AccountQuotaView[]> {
    // Fetch all accounts in parallel for faster loading
    const promises = accounts.map(async (account) => {
        try {
            const updated = await refreshCodexIfNeeded(account)
            const quota = await fetchCodexUsage(updated)
            updateQuotaCache({
                provider: "codex",
                accountId: account.id,
                displayName: account.email || account.id,
                bars: quota,
                updatedAt: new Date().toISOString(),
            })
            return {
                provider: "codex" as const,
                accountId: account.id,
                displayName: account.email || account.id,
                bars: quota,
            }
        } catch (error) {
            if (!isCertificateError(error)) {
                consola.warn("Codex quota fetch failed:", safeErrorMessage(error))
            }
            const cachedBars = getCachedBars("codex", account.id)
            if (cachedBars) {
                return {
                    provider: "codex" as const,
                    accountId: account.id,
                    displayName: account.email || account.id,
                    bars: cachedBars,
                }
            }
            return {
                provider: "codex" as const,
                accountId: account.id,
                displayName: account.email || account.id,
                bars: [
                    { key: "session", label: "5h", percentage: 0 },
                    { key: "week", label: "week", percentage: 0 },
                ],
            }
        }
    })
    return Promise.all(promises)
}

async function refreshCodexIfNeeded(account: ProviderAccount): Promise<ProviderAccount> {
    return refreshCodexAccountIfNeeded(account)
}

async function fetchCodexUsage(account: ProviderAccount): Promise<AccountBar[]> {
    const response = await fetchSecureJson("https://chatgpt.com/backend-api/wham/usage", {
        method: "GET",
        headers: {
            Authorization: `Bearer ${account.accessToken}`,
            Accept: "application/json",
        },
    })

    if (response.status === 401 && account.refreshToken) {
        const refreshed = await refreshCodexAccessToken(account.refreshToken, account.authSource)
        account.accessToken = refreshed.accessToken
        if (refreshed.expiresIn) {
            account.expiresAt = Date.now() + refreshed.expiresIn * 1000
        }
        authStore.saveAccount(account)
        return fetchCodexUsage(account)
    }

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Codex usage error ${response.status}`)
    }

    const data = response.data as any
    const rateLimit = data.rate_limit || {}
    const primary = rateLimit.primary_window || {}
    const secondary = rateLimit.secondary_window || {}

    return [
        {
            key: "session",
            label: "5h",
            percentage: 100 - (primary.used_percent || 0),
            resetTime: primary.reset_at ? new Date(primary.reset_at * 1000).toISOString() : undefined,
        },
        {
            key: "week",
            label: "week",
            percentage: 100 - (secondary.used_percent || 0),
            resetTime: secondary.reset_at ? new Date(secondary.reset_at * 1000).toISOString() : undefined,
        },
    ]
}

async function fetchCopilotQuotas(accounts: ProviderAccount[]): Promise<AccountQuotaView[]> {
    // Fetch all accounts in parallel for faster loading
    const promises = accounts.map(async (account) => {
        try {
            const bar = await fetchCopilotPremium(account)
            updateQuotaCache({
                provider: "copilot",
                accountId: account.id,
                displayName: account.login || account.id,
                bars: [bar],
                updatedAt: new Date().toISOString(),
            })
            return {
                provider: "copilot" as const,
                accountId: account.id,
                displayName: account.login || account.id,
                bars: [bar],
            }
        } catch (error) {
            consola.warn("Copilot quota fetch failed:", safeErrorMessage(error))
            const cachedBars = getCachedBars("copilot", account.id)
            if (cachedBars) {
                return {
                    provider: "copilot" as const,
                    accountId: account.id,
                    displayName: account.login || account.id,
                    bars: cachedBars,
                }
            }
            return {
                provider: "copilot" as const,
                accountId: account.id,
                displayName: account.login || account.id,
                bars: [{ key: "premium", label: "premium", percentage: 0 }],
            }
        }
    })
    return Promise.all(promises)
}

async function fetchZedQuotas(accounts: ProviderAccount[]): Promise<AccountQuotaView[]> {
    const promises = accounts.map(async (account) => {
        try {
            const overview = await fetchZedAccountOverview(account)
            const bars = [buildZedHostedBar(overview)]
            updateQuotaCache({
                provider: "zed",
                accountId: account.id,
                displayName: account.label || account.login || account.id,
                bars,
                updatedAt: new Date().toISOString(),
            })
            return {
                provider: "zed" as const,
                accountId: account.id,
                displayName: account.label || account.login || account.id,
                bars,
            }
        } catch (error) {
            consola.warn("Zed quota fetch failed:", safeErrorMessage(error))
            const cachedBars = getCachedBars("zed", account.id)
            if (cachedBars) {
                return {
                    provider: "zed" as const,
                    accountId: account.id,
                    displayName: account.label || account.login || account.id,
                    bars: cachedBars,
                }
            }
            return {
                provider: "zed" as const,
                accountId: account.id,
                displayName: account.label || account.login || account.id,
                bars: defaultZedBars(),
            }
        }
    })
    return Promise.all(promises)
}

async function fetchKiroQuotas(accounts: ProviderAccount[]): Promise<AccountQuotaView[]> {
    return accounts.map(account => {
        const bars = defaultKiroBars()
        updateQuotaCache({
            provider: "kiro",
            accountId: account.id,
            displayName: account.label || account.login || account.id,
            bars,
            updatedAt: new Date().toISOString(),
        })
        return {
            provider: "kiro" as const,
            accountId: account.id,
            displayName: account.label || account.login || account.id,
            bars,
        }
    })
}

function buildZedHostedBar(data: Awaited<ReturnType<typeof fetchZedAccountOverview>>): AccountBar {
    const plan = data.plan?.plan_v3 || ""
    const entitledPlans = new Set(["zed_pro", "zed_pro_trial", "zed_student"])
    return {
        key: "hosted",
        label: "hosted",
        percentage: entitledPlans.has(plan) ? 100 : 0,
        resetTime: data.plan?.subscription_period?.ended_at || undefined,
    }
}

async function fetchCopilotPremium(account: ProviderAccount): Promise<AccountBar> {
    let response: InsecureResponse
    try {
        response = await fetchSecureJson("https://api.github.com/copilot_internal/user", {
            method: "GET",
            headers: {
                Authorization: `Bearer ${account.accessToken}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        })
    } catch (error) {
        if (isCertificateError(error)) {
            return { key: "premium", label: "premium", percentage: 0 }
        }
        throw error
    }

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Copilot entitlement error ${response.status}`)
    }

    const data = response.data as any
    const premium = data.quota_snapshots?.premium_interactions
    const percent = derivePercent(premium)
    const reset = data.quota_reset_date_utc || data.quota_reset_date || data.limited_user_reset_date

    return {
        key: "premium",
        label: "premium",
        percentage: percent,
        resetTime: reset || undefined,
    }
}

function derivePercent(snapshot: any): number {
    if (!snapshot) return 0
    if (snapshot.unlimited === true) return 100
    if (typeof snapshot.percent_remaining === "number") return Math.round(snapshot.percent_remaining)
    if (typeof snapshot.remaining === "number" && typeof snapshot.entitlement === "number") {
        if (snapshot.entitlement <= 0) return 0
        return Math.round((snapshot.remaining / snapshot.entitlement) * 100)
    }
    return 0
}

function isCertificateError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false
    const code = (error as { code?: string }).code
    if (code === "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR") return true
    const message = String((error as { message?: string }).message || "")
    return message.toLowerCase().includes("certificate")
}

function isAuthError(error: unknown): boolean {
    if (!error) return false
    const message = String((error as { message?: string }).message || "")
    if (message.includes("401")) return true
    if (message.toLowerCase().includes("unauthenticated")) return true
    if (message.toLowerCase().includes("invalid_grant")) return true
    return false
}

type InsecureResponse = {
    status: number
    data: any
    text: string
}

async function fetchSecureJson(
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<InsecureResponse> {
    const response = await fetch(url, {
        method: options.method,
        headers: { "User-Agent": "anti-api", ...(options.headers || {}) },
        body: options.body,
        signal: AbortSignal.timeout(10_000),
    })
    const text = await response.text()
    let data: any = null
    if (text) {
        try { data = JSON.parse(text) } catch { }
    }
    return { status: response.status, data, text }
}
