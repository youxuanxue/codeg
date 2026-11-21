// Node 20.6+ loader. Transform only the official Gemini package, in memory;
// neither managed installs nor a user's system CLI are changed on disk.
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const helper = JSON.stringify(new URL("./artifacts.mjs", import.meta.url).href)
const packageOwners = new Map()

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
  // These class names are exported by Gemini CLI 0.60.0 and 0.70.0. Gate on
  // declarations, not arbitrary occurrences in references or source comments.
  const hasRead =
    /(?:var ReadFileTool = class|export class ReadFileTool extends)/.test(
      source
    )
  const hasStorage = /(?:var Storage = class|export class Storage\s*\{)/.test(
    source
  )
  if (!hasRead && !hasStorage) return result
  const additions = [
    `import { installReadCompatibility as codegInstallRead, installStorageContract as codegInstallStorage } from ${helper};`,
    hasRead ? "codegInstallRead(ReadFileTool);" : "",
    hasStorage ? "codegInstallStorage(Storage);" : "",
  ].join("\n")
  return { ...result, source: `${source}\n${additions}\n` }
}
