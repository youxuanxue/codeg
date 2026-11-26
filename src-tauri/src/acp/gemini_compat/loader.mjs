// Node 20.6+ loader. Transform only the official Gemini package, in memory;
// neither managed installs nor a user's system CLI are changed on disk.
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const helper = JSON.stringify(new URL("./artifacts.mjs", import.meta.url).href)
const retryHelper = JSON.stringify(new URL("./retry.mjs", import.meta.url).href)
const packageOwners = new Map()

// Gemini CLI 0.70 calls this warn only on the immediate TerminalQuota /
// ModelNotFound fallback inside retryWithBackoff. The later 429/5xx path says
// "Model fallback failed" and must keep resetting the attempt counter.
const FLASH_FALLBACK_SOURCE = [
  String.raw`if\s*\(\s*onPersistent429\s*\)\s*\{`,
  String.raw`\s*try\s*\{`,
  String.raw`\s*const fallbackModel = await onPersistent429\(\s*authType\s*,\s*classifiedError\s*\)\s*;`,
  String.raw`\s*if\s*\(\s*fallbackModel\s*\)\s*\{`,
  String.raw`\s*attempt\s*=\s*0;\s*currentDelay\s*=\s*initialDelayMs;\s*continue;\s*`,
  String.raw`\}\s*\}\s*catch\s*\(\s*fallbackError\s*\)\s*\{`,
  String.raw`\s*debugLogger\.warn\(\s*"Fallback to Flash model failed:",\s*fallbackError`,
].join("")

const FLASH_REPLACEMENT = `if (onPersistent429) {
            const codegFallbackAction = codegPersistentFallbackAction(classifiedError, codegModelNotFoundContinues);
            if (codegFallbackAction === "stop") throw classifiedError;
            try {
              const fallbackModel = await onPersistent429(authType, classifiedError);
              if (fallbackModel) {
                if (codegFallbackAction === "continue-once") codegModelNotFoundContinues++;
                attempt = 0;
                currentDelay = initialDelayMs;
                continue;
              }
            } catch (fallbackError) {
              debugLogger.warn("Fallback to Flash model failed:", fallbackError`

function flashPattern() {
  return new RegExp(FLASH_FALLBACK_SOURCE, "g")
}

function bodyBrace(source, signatureStart) {
  const open = source.indexOf("(", signatureStart)
  if (open < 0) return -1
  let depth = 0
  for (let index = open; index < source.length; index++) {
    const char = source[index]
    if (char === "(") depth++
    else if (char === ")") {
      depth--
      if (depth === 0) return source.indexOf("{", index)
    }
  }
  return -1
}

function insertCounters(source) {
  const anchor = '"Fallback to Flash model failed:"'
  const declaration = "\nlet codegModelNotFoundContinues = 0;"
  let result = source
  let from = 0
  while (from < result.length) {
    const at = result.indexOf(anchor, from)
    if (at < 0) break
    const signature = result.lastIndexOf("function retryWithBackoff(", at)
    if (signature < 0) {
      from = at + anchor.length
      continue
    }
    const brace = bodyBrace(result, signature)
    if (brace < 0 || brace > at) {
      from = at + anchor.length
      continue
    }
    // Only the declaration counts. The rewritten fallback sits near the top of
    // small fixtures and mentions the same name.
    const prelude = result.slice(brace + 1, brace + 64)
    if (prelude.includes("let codegModelNotFoundContinues")) {
      from = at + anchor.length
      continue
    }
    result = result.slice(0, brace + 1) + declaration + result.slice(brace + 1)
    from = at + anchor.length + declaration.length
  }
  return result
}

export function patchModelNotFoundRetry(source) {
  if (!source.includes('"Fallback to Flash model failed:"')) {
    return { source, patched: false, count: 0 }
  }
  const count = source.match(flashPattern())?.length ?? 0
  if (!count) return { source, patched: false, count: 0 }
  const replaced = source.replace(flashPattern(), FLASH_REPLACEMENT)
  const withCounter = insertCounters(replaced)
  if (!withCounter.includes("let codegModelNotFoundContinues = 0;")) {
    return { source, patched: false, count: 0 }
  }
  return { source: withCounter, patched: true, count }
}

async function isGeminiPackage(filename) {
  let directory = path.dirname(filename)
  const visited = []
  let allowed = false
  while (true) {
    if (packageOwners.has(directory)) {
      allowed = packageOwners.get(directory)
      break
    }
    visited.push(directory)
    try {
      const metadata = JSON.parse(
        await fs.readFile(path.join(directory, "package.json"), "utf8")
      )
      allowed = ["@google/gemini-cli", "@google/gemini-cli-core"].includes(
        metadata.name
      )
      break
    } catch (error) {
      if (error.code !== "ENOENT") break
    }
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  for (const directory of visited) packageOwners.set(directory, allowed)
  return allowed
}

export function transformGeminiModule(source) {
  const hasRead =
    /(?:var ReadFileTool = class|export class ReadFileTool extends)/.test(
      source
    )
  const hasStorage = /(?:var Storage = class|export class Storage\s*\{)/.test(
    source
  )
  const retry = patchModelNotFoundRetry(source)
  if (!hasRead && !hasStorage && !retry.patched) {
    return { source, changed: false }
  }
  const additions = []
  if (hasRead || hasStorage) {
    additions.push(
      `import { installReadCompatibility as codegInstallRead, installStorageContract as codegInstallStorage } from ${helper};`,
      hasRead ? "codegInstallRead(ReadFileTool);" : "",
      hasStorage ? "codegInstallStorage(Storage);" : ""
    )
  }
  if (retry.patched) {
    additions.push(
      `import { persistentFallbackAction as codegPersistentFallbackAction } from ${retryHelper};`
    )
  }
  return {
    source: `${retry.source}\n${additions.join("\n")}\n`,
    changed: true,
  }
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context)
  if (!url.startsWith("file:") || result.format !== "module" || !result.source)
    return result
  const filename = fileURLToPath(url)
  if (!filename.endsWith(".js") || !(await isGeminiPackage(filename)))
    return result
  const source = Buffer.isBuffer(result.source)
    ? result.source.toString("utf8")
    : String(result.source)
  // Class declarations are the 0.60 / 0.70 read_file markers. The fallback
  // patch keys off retryWithBackoff's Flash warn, including bundles that do
  // not declare ReadFileTool or Storage. A renamed upstream block fails open.
  const transformed = transformGeminiModule(source)
  if (!transformed.changed) return result
  return { ...result, source: transformed.source }
}
