// Loaded in the Gemini process, before its native read_file validation.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"

export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
const installed = Symbol.for("codeg.gemini.artifacts")
const stageDirectories = new Map()

export function canonicalPath(value) {
  return fs.realpathSync(value)
}

function within(root, target) {
  const relative = path.relative(root, target)
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  )
}

export function projectTempContract(directory) {
  // Do not create the directory here: Storage calls this during migrations too.
  // Gemini's own initialization owns creation and naming of the project tree.
  try {
    process.env.CODEG_GEMINI_PROJECT_TEMP = canonicalPath(directory)
  } catch {
    process.env.CODEG_GEMINI_PROJECT_TEMP = path.resolve(directory)
  }
  return directory
}

function stageDirectory(projectTemp) {
  let directory = stageDirectories.get(projectTemp)
  if (!directory) {
    directory = fs.mkdtempSync(path.join(projectTemp, "codeg-staged-"))
    stageDirectories.set(projectTemp, directory)
  }
  if (
    fs.lstatSync(directory).isSymbolicLink() ||
    !within(projectTemp, canonicalPath(directory))
  ) {
    throw new Error("Gemini artifact staging directory escaped project temp")
  }
  return directory
}

// Only regular, bounded files actually inside an OS temp root qualify. Check
// the real path as well as the spelling, so /tmp/link -> ~/.ssh is refused.
export function stageArtifact(
  source,
  config,
  roots = [
    os.tmpdir(),
    ...(process.platform === "win32" ? [] : ["/tmp", "/var/tmp"]),
  ]
) {
  if (typeof source !== "string" || !path.isAbsolute(source)) return source
  // Preserve all native access rules, including workspace aliases, ignored
  // files and reserved Gemini memory subtrees. Stage only a rejected read.
  if (!config.validatePathAccess(source, "read")) return source
  let realSource
  let allowedRoots
  try {
    realSource = canonicalPath(source)
    allowedRoots = roots.flatMap((root) => {
      try {
        return [canonicalPath(root)]
      } catch {
        return []
      }
    })
  } catch {
    return source // Native Gemini supplies the original missing-file error.
  }
  // macOS aliases can be denied by their spelling even when the canonical
  // workspace path is allowed. Let the native policy decide before copying.
  if (!config.validatePathAccess(realSource, "read")) return realSource
  if (!allowedRoots.some((root) => within(root, realSource))) return source
  const projectTemp = canonicalPath(config.storage.getProjectTempDir())
  // A denial INSIDE Gemini's temp tree is deliberate (e.g. memory/.inbox).
  if (within(projectTemp, realSource)) return source
  const workspaces =
    config.getWorkspaceContext?.().getDirectories?.() ??
    [config.getTargetDir?.()].filter(Boolean)
  if (
    workspaces.some((root) => {
      try {
        return within(canonicalPath(root), realSource)
      } catch {
        return false
      }
    })
  )
    return source
  const fd = fs.openSync(
    realSource,
    fs.constants.O_RDONLY |
      (fs.constants.O_NOFOLLOW ?? 0) |
      (fs.constants.O_NONBLOCK ?? 0)
  )
  try {
    const stat = fs.fstatSync(fd)
    if (
      !stat.isFile() ||
      stat.size > MAX_ARTIFACT_BYTES ||
      (process.getuid && stat.uid !== process.getuid())
    ) {
      return source
    }
    // Bind the path and opened inode before copying; never follow a changed
    // link or admit a file another local account owns in shared /tmp.
    const current = fs.statSync(realSource)
    if (
      canonicalPath(source) !== realSource ||
      current.dev !== stat.dev ||
      current.ino !== stat.ino
    )
      return source
    const content = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < content.length) {
      const count = fs.readSync(
        fd,
        content,
        offset,
        content.length - offset,
        offset
      )
      if (!count) throw new Error("Temporary artifact changed while staging")
      offset += count
    }
    const after = fs.fstatSync(fd)
    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    ) {
      throw new Error("Temporary artifact changed while staging")
    }
    const directory = stageDirectory(projectTemp)
    const digest = createHash("sha256")
      .update(realSource)
      .update("\0")
      .update(content)
      .digest("hex")
    const destination = path.join(
      directory,
      `${digest}${path.extname(realSource)}`
    )
    try {
      fs.writeFileSync(destination, content, { flag: "wx", mode: 0o600 })
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      // Never reuse a substituted symlink or stale/corrupted staged file.
      if (
        !fs.lstatSync(destination).isFile() ||
        fs.statSync(destination).size !== content.length ||
        !fs.readFileSync(destination).equals(content)
      )
        throw error
    }
    return destination
  } finally {
    fs.closeSync(fd)
  }
}

export function installReadCompatibility(Tool) {
  if (Tool.prototype[installed]) return
  const validate = Tool.prototype.validateToolParamValues
  if (typeof validate !== "function")
    throw new Error("Codeg Gemini compatibility: read_file validator changed")
  Tool.prototype.validateToolParamValues = function (params) {
    try {
      params.file_path = stageArtifact(params.file_path, this.config)
    } catch (error) {
      // Do not turn a staging failure into permission to read the source.
      return `Codeg Gemini artifact staging failed: ${error.message}`
    }
    return validate.call(this, params)
  }
  Tool.prototype[installed] = true
}

export function installStorageContract(Storage) {
  if (Storage.prototype[installed]) return
  const getTemp = Storage.prototype.getProjectTempDir
  if (typeof getTemp !== "function")
    throw new Error("Codeg Gemini compatibility: project temp resolver changed")
  Storage.prototype.getProjectTempDir = function () {
    return projectTempContract(getTemp.call(this))
  }
  Storage.prototype[installed] = true
}

// On a graceful CLI exit these are no longer needed. Interrupted runs remain
// in Gemini's project temp tree and follow its normal temp retention policy.
process.once("exit", () => {
  for (const [root, directory] of stageDirectories) {
    try {
      if (
        within(root, canonicalPath(directory)) &&
        !fs.lstatSync(directory).isSymbolicLink()
      ) {
        fs.rmSync(directory, { recursive: true, force: true })
      }
    } catch {
      /* Best effort; never fail CLI shutdown. */
    }
  }
})
