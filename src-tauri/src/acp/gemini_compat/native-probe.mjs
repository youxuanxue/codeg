// Offline upgrade check against an installed official Gemini core module.
// Invoke with --import ./register.mjs and the module path as the argument.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import assert from "node:assert/strict"
import { pathToFileURL } from "node:url"

assert.ok(
  process.argv[2],
  "Pass the official module exporting Config and ReadFileTool"
)
const home = fs.mkdtempSync(path.join(os.tmpdir(), "codeg-gemini-probe-home-"))
const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), "codeg-gemini-probe-artifacts-")
)
process.env.HOME = home
process.env.USERPROFILE = home
// Gemini's explicit data-home override takes precedence over os.homedir().
// Keep upgrade probes isolated even when the caller uses a relocated profile.
process.env.GEMINI_CLI_HOME = home
try {
  const { Config, ReadFileTool } = await import(
    pathToFileURL(path.resolve(process.argv[2])).href
  )
  const workspace = path.join(home, "workspace")
  fs.mkdirSync(workspace)
  const config = new Config({
    targetDir: workspace,
    cwd: workspace,
    sessionId: "codeg-offline-probe",
    debugMode: false,
    model: "gemini-2.5-pro",
    usageStatisticsEnabled: false,
  })
  await config.storage.initialize()
  config.storage.ensureProjectTempDirExists()
  const projectTemp = fs.realpathSync(config.storage.getProjectTempDir())
  assert.ok(
    projectTemp.startsWith(`${fs.realpathSync(home)}${path.sep}`),
    "native probe must keep Gemini metadata in its isolated home"
  )
  const file = path.join(directory, "screenshot.png")
  fs.writeFileSync(
    file,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRfoAAAAASUVORK5CYII=",
      "base64"
    )
  )
  assert.ok(
    config.validatePathAccess(file, "read"),
    "native config must reject original"
  )
  const tool = new ReadFileTool(config, config.getMessageBus())
  const params = { file_path: file }
  const result = await tool
    .build(params)
    .execute({ abortSignal: new AbortController().signal })
  assert.equal(result.error, undefined, JSON.stringify(result.error))
  const parts = Array.isArray(result.llmContent)
    ? result.llmContent
    : [result.llmContent]
  assert.ok(parts.some((part) => part.inlineData?.mimeType === "image/png"))
  assert.notEqual(params.file_path, file)
  assert.equal(config.validatePathAccess(params.file_path, "read"), null)
  assert.deepEqual(fs.readFileSync(params.file_path), fs.readFileSync(file))
  assert.equal(
    process.env.CODEG_GEMINI_PROJECT_TEMP,
    fs.realpathSync(config.storage.getProjectTempDir())
  )
  console.log(
    "PASS: native read_file returned staged PNG; original remains rejected"
  )
} finally {
  fs.rmSync(directory, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
}
