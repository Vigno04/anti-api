/**
 * Semi-automatic Antigravity model catalog.
 *
 * Instead of hardcoding which models to expose, we look at the model IDs
 * reported by Antigravity (fetchAvailableModels) and keep only the highest
 * version of each family:
 *   - claude-opus, claude-sonnet
 *   - gemini-pro, gemini-flash, gemini-flash-lite
 *   - gpt-oss
 * The static list in config.ts is only used as a seed before the first sync.
 */

import { BASE_OFFICIAL_MODELS, THINKING_VARIANT_MODELS } from "./config"

export type ModelFamily =
    | "claude-opus"
    | "claude-sonnet"
    | "gemini-argon"
    | "gemini-pro"
    | "gemini-flash"
    | "gemini-flash-lite"
    | "gpt-oss"

export interface CatalogModel {
    id: string
    name: string
}

interface ParsedModel {
    id: string
    family: ModelFamily
    version: number[]
    variant: string // "", "thinking", "high", "medium", "low"
}

const FAMILIES: ModelFamily[] = [
    "claude-opus",
    "claude-sonnet",
    "gemini-argon",
    "gemini-pro",
    "gemini-flash",
    "gemini-flash-lite",
    "gpt-oss",
]

// Which native variant a base/family alias resolves to (first one that exists wins).
const VARIANT_PREFERENCE: Record<ModelFamily, string[]> = {
    "claude-opus": ["thinking", "high", "medium", "low", ""],
    "claude-sonnet": ["", "medium", "high", "low", "thinking"],
    "gemini-argon": ["high", "thinking", "medium", "", "low"],
    "gemini-pro": ["high", "agent", "", "low"],
    "gemini-flash": ["medium", "", "high", "low"],
    "gemini-flash-lite": ["", "low"],
    "gpt-oss": ["medium", "", "high", "low"],
}

function toVersion(raw: string): number[] {
    return raw.split(/[-.]/).map(n => parseInt(n, 10))
}

function compareVersions(a: number[], b: number[]): number {
    const len = Math.max(a.length, b.length)
    for (let i = 0; i < len; i++) {
        const diff = (a[i] ?? 0) - (b[i] ?? 0)
        if (diff !== 0) return diff
    }
    return 0
}

export function parseModelId(id: string): ParsedModel | null {
    const lower = id.trim().toLowerCase()

    // Gemini Argon (e.g. gemini-4-argon, gemini-argon, argon)
    let m = lower.match(/^gemini-(?:(\d{1,2}(?:\.\d{1,2})?)-)?argon(?:-(high|medium|low|thinking))?$/)
    if (m) {
        return {
            id,
            family: "gemini-argon",
            version: m[1] ? toVersion(m[1]) : [4],
            variant: m[2] || "",
        }
    }
    if (lower === "argon") {
        return {
            id,
            family: "gemini-argon",
            version: [4],
            variant: "",
        }
    }

    // Gemini Pro aliases
    if (lower === "gemini-pro-agent") {
        return {
            id,
            family: "gemini-pro",
            version: [3, 1], // maps to Gemini 3.1 Pro High/Agent tier
            variant: "agent",
        }
    }

    // Claude (Opus / Sonnet), supporting -high, -medium, -low, -thinking
    m = lower.match(/^claude-(opus|sonnet)-(\d{1,2}(?:[-.]\d{1,2})?)(?:-(thinking|high|medium|low))?$/)
    if (m) {
        return {
            id,
            family: `claude-${m[1]}` as ModelFamily,
            version: toVersion(m[2]),
            variant: m[3] || "",
        }
    }

    // Gemini (Flash, Flash Lite, Pro)
    m = lower.match(/^gemini-(\d{1,2}(?:\.\d{1,2})?)-(flash-lite|flash|pro)(?:-(high|medium|low|thinking))?$/)
    if (m) {
        return {
            id,
            family: `gemini-${m[2]}` as ModelFamily,
            version: toVersion(m[1]),
            variant: m[3] || "",
        }
    }

    // Gemini 4 Pro / Flash / etc. if formatted like gemini-4-pro or gemini-4-flash
    m = lower.match(/^gemini-(\d{1,2})-(flash-lite|flash|pro)(?:-(high|medium|low|thinking))?$/)
    if (m) {
        return {
            id,
            family: `gemini-${m[2]}` as ModelFamily,
            version: [parseInt(m[1], 10)],
            variant: m[3] || "",
        }
    }

    // GPT-OSS
    m = lower.match(/^gpt-oss-(\d{1,4})b(?:-(high|medium|low))?$/)
    if (m) {
        return { id, family: "gpt-oss", version: [parseInt(m[1], 10)], variant: m[2] || "" }
    }

    return null
}

function baseIdFor(family: ModelFamily, version: number[]): string {
    switch (family) {
        case "claude-opus":
        case "claude-sonnet":
            return `${family}-${version.join("-")}`
        case "gpt-oss":
            return `gpt-oss-${version[0]}b`
        case "gemini-argon":
            return `gemini-${version.join(".")}-argon`
        default: {
            const [, kind] = family.split(/-(.+)/)
            return `gemini-${version.join(".")}-${kind}`
        }
    }
}

function titleCase(s: string): string {
    return s
        .split("-")
        .map(p => (p ? p[0].toUpperCase() + p.slice(1) : p))
        .join(" ")
}

function labelFor(family: ModelFamily, version: number[], variant: string): string {
    let base: string
    switch (family) {
        case "claude-opus":
            base = `Claude Opus ${version.join(".")}`
            break
        case "claude-sonnet":
            base = `Claude Sonnet ${version.join(".")}`
            break
        case "gpt-oss":
            base = `GPT-OSS ${version[0]}B`
            break
        default:
            base = `Gemini ${version.join(".")} ${titleCase(family.slice("gemini-".length))}`
    }
    return variant ? `${base} (${titleCase(variant)})` : base
}

export interface AntigravityCatalog {
    /** Clean/unified IDs, e.g. claude-opus-5-5, gemini-3.8-flash */
    base: CatalogModel[]
    /** Explicit native variants of the latest models (thinking/high/medium/low) */
    variants: CatalogModel[]
    /** Every ID/alias that is considered "latest" (base + variants) */
    selectedIds: Set<string>
    /** alias/base ID -> native Antigravity model ID */
    aliases: Map<string, string>
}

export function buildCatalog(ids: string[]): AntigravityCatalog {
    const byFamily = new Map<ModelFamily, ParsedModel[]>()
    for (const id of new Set(ids)) {
        const parsed = parseModelId(id)
        if (!parsed) continue
        const list = byFamily.get(parsed.family) || []
        list.push(parsed)
        byFamily.set(parsed.family, list)
    }

    const base: CatalogModel[] = []
    const variants: CatalogModel[] = []
    const selectedIds = new Set<string>()
    const aliases = new Map<string, string>()

    for (const family of FAMILIES) {
        const members = byFamily.get(family)
        if (!members || members.length === 0) continue

        let latest = members[0].version
        for (const member of members) {
            if (compareVersions(member.version, latest) > 0) latest = member.version
        }
        const current = members.filter(m => compareVersions(m.version, latest) === 0)

        let target: ParsedModel | undefined
        for (const variant of VARIANT_PREFERENCE[family]) {
            target = current.find(m => m.variant === variant)
            if (target) break
        }
        target = target || current[0]

        const baseId = baseIdFor(family, latest)
        base.push({ id: baseId, name: labelFor(family, latest, "") })
        selectedIds.add(baseId)
        aliases.set(baseId, target.id)
        aliases.set(family, target.id) // stable alias, e.g. "claude-opus"
        if (family === "gemini-argon") {
            aliases.set("argon", target.id)
        }

        for (const member of current) {
            selectedIds.add(member.id)
            if (member.id !== baseId) {
                variants.push({ id: member.id, name: labelFor(family, latest, member.variant) })
            }
        }
    }

    return { base, variants, selectedIds, aliases }
}

const STATIC_IDS = [...BASE_OFFICIAL_MODELS, ...THINKING_VARIANT_MODELS].map(m => m.id)

let remoteIds: string[] = []
let cached: AntigravityCatalog | null = null

/** Called whenever the discovered Antigravity model list changes. */
export function setDiscoveredAntigravityModelIds(ids: string[]): void {
    remoteIds = ids
    cached = null
}

export function getAntigravityCatalog(): AntigravityCatalog {
    if (!cached) {
        cached = buildCatalog(remoteIds.length > 0 ? remoteIds : STATIC_IDS)
    }
    return cached
}

/** Resolves a base/family alias to the native Antigravity model ID, if known. */
export function resolveAntigravityAlias(model: string): string | undefined {
    return getAntigravityCatalog().aliases.get(model)
}

export function isLatestAntigravityModel(id: string): boolean {
    const catalog = getAntigravityCatalog()
    // Models outside the six tracked families (images, tiered, ...) are never "latest"
    return catalog.selectedIds.has(id)
}
