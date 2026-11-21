import assert from "node:assert/strict"
import { test, after } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  canonicalPath,
  stageArtifact,
  installReadCompatibility,
  installStorageContract,
  MAX_ARTIFACT_BYTES,
} from "./artifacts.mjs"

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codeg-gemini-test-"))
after(() => fs.rmSync(temporary, { recursive: true, force: true }))
const directory = (name) => {
  const result = path.join(temporary, name)
  fs.mkdirSync(result, { recursive: true })
  return result
}
const workspace = directory("workspace")
const projectTemp = directory("gemini-project-temp")
const sourceRoot = directory("os-temp")
const outsideRoot = directory("outside-temp")
const contained = (root, target) => {
  const relative = path.relative(canonicalPath(root), canonicalPath(target))
  return (
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  )
}
const config = {
  storage: { getProjectTempDir: () => projectTemp },
  getTargetDir: () => workspace,
  validatePathAccess(value) {
    try {
      if (value.includes("reserved")) return "reserved path"
      return [workspace, projectTemp].some((root) => contained(root, value))
        ? null
        : "Path not in workspace"
    } catch {
      return "missing"
    }
  },
}
const source = (name, data = "image-data") => {
  const file = path.join(sourceRoot, name)
  fs.writeFileSync(file, data)
  return file
}
const stage = (file) => stageArtifact(file, config, [sourceRoot])

// Mirror Gemini's native order: build validates BEFORE creating the invocation
// and BEFORE BeforeTool/ACP fs callbacks. This is why host-side staging fails.
class NativeReadFileTool {
  constructor() {
    this.config = config
  }
  validateToolParamValues(params) {
    return this.config.validatePathAccess(params.file_path, "read")
  }
  build(params) {
    const error = this.validateToolParamValues(params)
    if (error) throw new Error(error)
    return { execute: () => fs.readFileSync(params.file_path) }
  }
}

test("screenshot regression: native read rejects /tmp PNG, compatibility stages before validation", () => {
  const file = source(
    "d1-p08-08.png",
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  )
  const tool = new NativeReadFileTool()
  assert.throws(() => tool.build({ file_path: file }), /Path not in workspace/)
  installReadCompatibility(NativeReadFileTool)
  installReadCompatibility(NativeReadFileTool)
  const params = { file_path: file, start_line: 3 }
  assert.deepEqual(tool.build(params).execute(), fs.readFileSync(file))
  assert.ok(contained(projectTemp, params.file_path))
  assert.equal(params.start_line, 3)
  assert.equal(fs.readFileSync(file).length, 8)
})

test("workspace, native project-temp and relative paths retain native semantics", () => {
  for (const root of [workspace, projectTemp]) {
    const file = path.join(root, "unchanged.txt")
    fs.writeFileSync(file, "native")
    assert.equal(stage(file), file)
  }
  assert.equal(stage("relative.png"), "relative.png")
  assert.equal(stage(null), null)
})

test("missing files and non-temp files are not staged", () => {
  const missing = path.join(sourceRoot, "missing.png")
  assert.equal(stage(missing), missing)
  const outside = path.join(outsideRoot, "secret")
  fs.writeFileSync(outside, "private")
  assert.equal(stage(outside), outside)
})

test("a rejected path alias uses the canonical path only when native policy allows it", () => {
  const file = path.join(workspace, "canonical.txt")
  fs.writeFileSync(file, "workspace")
  // The redundant component simulates a spelling-sensitive native validator
  // on every OS; real macOS /tmp aliases are exercised separately below.
  const alias = `${workspace}${path.sep}.${path.sep}canonical.txt`
  const nativeConfig = {
    ...config,
    validatePathAccess: (value) =>
      value === canonicalPath(file) ? null : "denied",
  }
  assert.equal(stageArtifact(alias, nativeConfig, []), canonicalPath(file))
  assert.equal(
    stageArtifact(
      alias,
      { ...nativeConfig, validatePathAccess: () => "denied" },
      []
    ),
    alias
  )
})

test("directory and oversized file are refused", () => {
  assert.equal(stage(sourceRoot), sourceRoot)
  const oversized = source("large.png", "")
  fs.truncateSync(oversized, MAX_ARTIFACT_BYTES + 1)
  assert.equal(stage(oversized), oversized)
})

test("reserved workspace and Gemini temp subtrees cannot be laundered through staging", () => {
  for (const root of [workspace, projectTemp]) {
    const file = path.join(root, "reserved")
    fs.writeFileSync(file, "private")
    assert.equal(stageArtifact(file, config, [temporary]), file)
  }
})

test("same basename in different folders and changed content do not collide", () => {
  const a = source("same.png", "first")
  const other = directory("os-temp/nested")
  const b = path.join(other, "same.png")
  fs.writeFileSync(b, "second")
  const first = stage(a)
  assert.notEqual(first, stage(b))
  assert.equal(stage(a), first)
  fs.writeFileSync(a, "updated")
  const updated = stage(a)
  assert.notEqual(first, updated)
  assert.equal(fs.readFileSync(first, "utf8"), "first")
  assert.equal(fs.readFileSync(updated, "utf8"), "updated")
})

test("spaces, Unicode and shell metacharacters are treated as path data", () => {
  const file = source('页面 $(touch oops) `echo x` " name.png', "pixels")
  assert.equal(fs.readFileSync(stage(file), "utf8"), "pixels")
  assert.equal(fs.existsSync(path.join(process.cwd(), "oops")), false)
})

test("native Storage resolver owns contract naming and relocated data homes", () => {
  class Storage {
    getProjectTempDir() {
      return path.join(projectTemp, "native-slug")
    }
  }
  installStorageContract(Storage)
  installStorageContract(Storage)
  assert.equal(
    new Storage().getProjectTempDir(),
    path.join(projectTemp, "native-slug")
  )
  assert.equal(
    process.env.CODEG_GEMINI_PROJECT_TEMP,
    path.join(projectTemp, "native-slug")
  )
  fs.mkdirSync(path.join(projectTemp, "native-slug"))
  new Storage().getProjectTempDir()
  assert.equal(
    process.env.CODEG_GEMINI_PROJECT_TEMP,
    canonicalPath(path.join(projectTemp, "native-slug"))
  )
})

test(
  "symlink out of OS temp is refused; temp aliases share one staged copy",
  { skip: process.platform === "win32" },
  () => {
    const outside = path.join(outsideRoot, "private.txt")
    fs.writeFileSync(outside, "secret")
    const escape = path.join(sourceRoot, "escape")
    fs.symlinkSync(outside, escape)
    assert.equal(stage(escape), escape)
    const file = source("alias.png")
    const alias = path.join(temporary, "alias-temp")
    fs.symlinkSync(sourceRoot, alias)
    assert.equal(stage(path.join(alias, "alias.png")), stage(file))
  }
)

test(
  "macOS /tmp and /private/tmp produce the same canonical file and staged copy",
  { skip: process.platform !== "darwin" },
  () => {
    const dir = fs.mkdtempSync("/tmp/codeg-gemini-alias-")
    try {
      const file = path.join(dir, "slide.png")
      fs.writeFileSync(file, "macOS")
      const real = file.replace(/^\/tmp\//, "/private/tmp/")
      assert.equal(canonicalPath(file), canonicalPath(real))
      assert.equal(stageArtifact(file, config), stageArtifact(real, config))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
)

test(
  "FIFO is refused without blocking",
  { skip: process.platform === "win32" },
  () => {
    const fifo = path.join(sourceRoot, "pipe")
    execFileSync("mkfifo", [fifo])
    assert.equal(stage(fifo), fifo)
  }
)

test("loader wraps real module execution only inside official Gemini packages", () => {
  const register = fileURLToPath(new URL("./register.mjs", import.meta.url))
  for (const official of [true, false]) {
    const pkg = directory(official ? "official" : "unrelated")
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({
        name: official ? "@google/gemini-cli" : "other-tool",
        type: "module",
      })
    )
    fs.writeFileSync(
      path.join(pkg, "core.js"),
      `
      import fs from 'node:fs';
      export class Storage { getProjectTempDir() { return process.env.TEST_PROJECT_TEMP; } }
      export class ReadFileTool extends Object {
        constructor() { super(); this.config = { storage: new Storage(), validatePathAccess(p) { return p.startsWith(fs.realpathSync(process.env.TEST_PROJECT_TEMP)) ? null : 'Path not in workspace'; } }; }
        validateToolParamValues(params) { return this.config.validatePathAccess(params.file_path); }
        build(params) { const error = this.validateToolParamValues(params); if (error) throw Error(error); return { execute: () => fs.readFileSync(params.file_path, 'utf8') }; }
      }
    `
    )
    fs.writeFileSync(
      path.join(pkg, "main.mjs"),
      `
      import { Storage, ReadFileTool } from './core.js';
      const temp = new Storage().getProjectTempDir();
      const params = { file_path: process.env.TEST_SOURCE };
      console.log(JSON.stringify({ data: new ReadFileTool().build(params).execute(), path: params.file_path, contract: process.env.CODEG_GEMINI_PROJECT_TEMP, temp }));
    `
    )
    const result = spawnSync(
      process.execPath,
      ["--import", register, path.join(pkg, "main.mjs")],
      {
        encoding: "utf8",
        timeout: 20000,
        env: {
          ...process.env,
          TEST_SOURCE: source(`loader-${official}.png`, "pixels"),
          TEST_PROJECT_TEMP: projectTemp,
        },
      }
    )
    if (official) {
      assert.equal(result.status, 0, result.stderr)
      const output = JSON.parse(result.stdout)
      assert.equal(output.data, "pixels")
      assert.ok(output.path.startsWith(canonicalPath(projectTemp)))
      assert.equal(output.contract, canonicalPath(projectTemp))
    } else {
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /Path not in workspace/)
    }
  }
})
