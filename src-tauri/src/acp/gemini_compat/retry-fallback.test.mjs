import assert from "node:assert/strict"
import { test, after } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import {
  MAX_MODEL_NOT_FOUND_CONTINUES,
  isUnsupportedModelError,
  persistentFallbackAction,
} from "./retry.mjs"
import { patchModelNotFoundRetry, transformGeminiModule } from "./loader.mjs"

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codeg-gemini-retry-"))
after(() => fs.rmSync(temporary, { recursive: true, force: true }))

const SERVER_FALLBACK = `if (onPersistent429) {
            try {
              const fallbackModel = await onPersistent429(authType, classifiedError);
              if (fallbackModel) {
                attempt = 0;
                currentDelay = initialDelayMs;
                continue;
              }
            } catch (fallbackError) {
              debugLogger.warn("Model fallback failed:", fallbackError);
            }
          }`

// Compact 0.70 control flow: ModelNotFound shares the Flash warn branch with
// terminal quota. 5xx exhaustion uses a different warn and must stay unbounded.
const fixture = `
const debugLogger = { warn() {} }
function enrichQuotaError(error) { return error }
export class ModelNotFoundError extends Error {
  constructor(message, code = 404) {
    super(message)
    this.name = "ModelNotFoundError"
    this.code = code
  }
}
export class TerminalQuotaError extends Error {
  constructor(message) {
    super(message)
    this.name = "TerminalQuotaError"
    this.status = 429
  }
}
function serverError(status) {
  const error = new Error("upstream " + status)
  error.status = status
  return error
}
export async function retryWithBackoff(fn, options) {
  const { maxAttempts, initialDelayMs, maxDelayMs, onPersistent429, authType } = options
  let attempt = 0
  let currentDelay = initialDelayMs
  while (attempt < maxAttempts) {
    attempt++
    try {
      return await fn()
    } catch (error40) {
      const classifiedError = error40
      if (classifiedError instanceof TerminalQuotaError || classifiedError instanceof ModelNotFoundError) {
          if (onPersistent429) {
            try {
              const fallbackModel = await onPersistent429(authType, classifiedError);
              if (fallbackModel) {
                attempt = 0;
                currentDelay = initialDelayMs;
                continue;
              }
            } catch (fallbackError) {
              debugLogger.warn("Fallback to Flash model failed:", fallbackError);
            }
          }
          throw classifiedError instanceof Error ? enrichQuotaError(classifiedError, authType) : classifiedError;
      }
      const errorCode = classifiedError.status
      const is500 = errorCode !== undefined && errorCode >= 500 && errorCode < 600
      if (is500) {
        if (attempt >= maxAttempts) {
          ${SERVER_FALLBACK}
          throw classifiedError
        }
        await new Promise((resolve) => setTimeout(resolve, 0))
        currentDelay = Math.min(maxDelayMs, currentDelay * 2)
        continue
      }
      throw error40
    }
  }
  throw new Error("Retry attempts exhausted")
}
function options(onPersistent429, maxAttempts = 5) {
  return {
    maxAttempts,
    initialDelayMs: 0,
    maxDelayMs: 0,
    authType: "api-key",
    onPersistent429,
  }
}
async function drive(fn, onPersistent429, maxAttempts) {
  let calls = 0
  let fallbacks = 0
  const wrapped = async (authType, error) => {
    fallbacks++
    return onPersistent429(authType, error)
  }
  try {
    const value = await retryWithBackoff(
      async () => {
        calls++
        return fn(calls)
      },
      options(wrapped, maxAttempts)
    )
    return { calls, fallbacks, value }
  } catch (error) {
    const wrappedMessage = "Failed to generate content with model gemini-3-flash-preview: " + error.message
    return {
      calls,
      fallbacks,
      name: error.name,
      message: error.message,
      errorType: error.message === "tight-loop" ? "TIGHT_LOOP" : "WEB_SEARCH_FAILED",
      toolMessage: 'Error during web search for query "news": ' + wrappedMessage,
    }
  }
}
export async function runAll() {
  return {
    notFoundLoop: await drive(async (calls) => {
      if (calls > 40) throw new Error("tight-loop")
      throw new ModelNotFoundError("models/gemini-3-flash-preview is not found")
    }, async () => true),
    notFoundSwitch: await drive(async (calls) => {
      if (calls === 1) throw new ModelNotFoundError("models/gemini-3-flash-preview is not found")
      return "ok"
    }, async () => true),
    notFoundDecline: await drive(
      async () => {
        throw new ModelNotFoundError("models/gemini-3-flash-preview is not found")
      },
      async () => false
    ),
    quota: await drive(async (calls) => {
      if (calls < 4) throw new TerminalQuotaError("quota")
      return "ok"
    }, async () => true),
    quotaAfterNotFound: await drive(async (calls) => {
      if (calls === 1) throw new ModelNotFoundError("models/gemini-3-flash-preview is not found")
      if (calls < 4) throw new TerminalQuotaError("quota")
      return "ok"
    }, async () => true),
    serverRetry: await drive(async (calls) => {
      if (calls < 3) throw serverError(503)
      return "ok"
    }, async () => {
      throw new Error("5xx backoff must not ask for model fallback")
    }),
    serverFallback: await drive(
      async (calls) => {
        if (calls === 1) throw serverError(500)
        return "ok"
      },
      async () => true,
      1
    ),
    serverAfterNotFound: await drive(async (calls) => {
      if (calls === 1) throw new ModelNotFoundError("models/gemini-3-flash-preview is not found")
      if (calls < 4) throw serverError(503)
      return "ok"
    }, async () => true),
  }
}
`

function assertBounded(result) {
  assert.equal(result.notFoundLoop.errorType, "WEB_SEARCH_FAILED")
  assert.equal(result.notFoundLoop.calls, 2)
  assert.equal(result.notFoundLoop.fallbacks, 1)
  assert.equal(result.notFoundLoop.name, "ModelNotFoundError")
  assert.match(result.notFoundLoop.toolMessage, /gemini-3-flash-preview/)
  assert.match(result.notFoundLoop.toolMessage, /is not found/)
  assert.match(
    result.notFoundLoop.toolMessage,
    /WEB_SEARCH_FAILED|Error during web search/
  )

  assert.equal(result.notFoundSwitch.value, "ok")
  assert.equal(result.notFoundSwitch.calls, 2)
  assert.equal(result.notFoundSwitch.fallbacks, 1)

  assert.equal(result.notFoundDecline.calls, 1)
  assert.equal(result.notFoundDecline.fallbacks, 1)
  assert.equal(result.notFoundDecline.name, "ModelNotFoundError")

  assert.equal(result.quota.value, "ok")
  assert.equal(result.quota.calls, 4)
  assert.equal(result.quota.fallbacks, 3)

  assert.equal(result.quotaAfterNotFound.value, "ok")
  assert.equal(result.quotaAfterNotFound.calls, 4)
  assert.equal(result.quotaAfterNotFound.fallbacks, 3)

  assert.equal(result.serverRetry.value, "ok")
  assert.equal(result.serverRetry.calls, 3)
  assert.equal(result.serverRetry.fallbacks, 0)

  assert.equal(result.serverFallback.value, "ok")
  assert.equal(result.serverFallback.calls, 2)
  assert.equal(result.serverFallback.fallbacks, 1)

  assert.equal(result.serverAfterNotFound.value, "ok")
  assert.equal(result.serverAfterNotFound.calls, 4)
  assert.equal(result.serverAfterNotFound.fallbacks, 1)
}

function assertUnpatched(result) {
  assert.equal(result.notFoundLoop.errorType, "TIGHT_LOOP")
  assert.ok(result.notFoundLoop.calls > 40)
  assert.ok(result.notFoundLoop.fallbacks > 30)
  assert.equal(result.notFoundSwitch.value, "ok")
  assert.equal(result.quota.value, "ok")
  assert.equal(result.quota.fallbacks, 3)
  assert.equal(result.serverRetry.value, "ok")
  assert.equal(result.serverRetry.fallbacks, 0)
  assert.equal(result.serverFallback.value, "ok")
  assert.equal(result.serverFallback.fallbacks, 1)
}

async function importSource(name, source) {
  const file = path.join(temporary, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, source)
  return import(pathToFileURL(file).href)
}

test("unsupported model errors are capped and quota or 5xx are not", () => {
  assert.equal(MAX_MODEL_NOT_FOUND_CONTINUES, 1)
  const missing = { name: "ModelNotFoundError", code: 404 }
  assert.equal(isUnsupportedModelError(missing), true)
  assert.equal(isUnsupportedModelError({ status: 404 }), true)
  assert.equal(isUnsupportedModelError({ code: "404" }), true)
  assert.equal(persistentFallbackAction(missing, 0), "continue-once")
  assert.equal(persistentFallbackAction(missing, 1), "stop")
  assert.equal(
    persistentFallbackAction({ status: 404 }, undefined),
    "continue-once"
  )

  for (const error of [
    null,
    { name: "TerminalQuotaError", status: 429 },
    { name: "RetryableQuotaError", status: 429 },
    { status: 500 },
    { status: 503 },
    { status: 499 },
  ]) {
    assert.equal(isUnsupportedModelError(error), false)
    assert.equal(persistentFallbackAction(error, 0), "continue")
    assert.equal(persistentFallbackAction(error, 4), "continue")
  }
})

test("flash fallback is rewritten once and the 5xx fallback is left in place", () => {
  const once = patchModelNotFoundRetry(fixture)
  assert.equal(once.patched, true)
  assert.equal(once.count, 1)
  assert.equal(once.source.includes(SERVER_FALLBACK), true)
  assert.equal(
    once.source.includes("let codegModelNotFoundContinues = 0;"),
    true
  )
  const flash = once.source.indexOf('"Fallback to Flash model failed:"')
  const model = once.source.indexOf('"Model fallback failed:"')
  assert.equal(
    once.source
      .slice(flash - 700, flash)
      .includes("codegPersistentFallbackAction"),
    true
  )
  assert.equal(
    once.source
      .slice(model - 700, model)
      .includes("codegPersistentFallbackAction"),
    false
  )
  const twice = patchModelNotFoundRetry(once.source)
  assert.equal(twice.patched, false)
  assert.equal(twice.source, once.source)
})

test("pretty-printed Gemini fallback keeps the same guard boundary", () => {
  const pretty = `
async function retryWithBackoff(fn3, options) {
  let attempt = 0;
  if (onPersistent429) {
    try {
      const fallbackModel = await onPersistent429(
        authType,
        classifiedError
      );
      if (fallbackModel) {
        attempt = 0;
        currentDelay = initialDelayMs;
        continue;
      }
    } catch (fallbackError) {
      debugLogger.warn(
        "Fallback to Flash model failed:",
        fallbackError
      );
    }
  }
  if (onPersistent429) {
    try {
      const fallbackModel = await onPersistent429(
        authType,
        classifiedError
      );
      if (fallbackModel) {
        attempt = 0;
        currentDelay = initialDelayMs;
        continue;
      }
    } catch (fallbackError) {
      debugLogger.warn("Model fallback failed:", fallbackError);
    }
  }
}
`
  const patched = patchModelNotFoundRetry(pretty)
  assert.equal(patched.count, 1)
  assert.equal(patched.patched, true)
  const model = patched.source.indexOf('"Model fallback failed:"')
  const serverBranch = patched.source.lastIndexOf("if (onPersistent429)", model)
  assert.equal(
    patched.source
      .slice(serverBranch, model)
      .includes("codegPersistentFallbackAction"),
    false
  )
  assert.equal(
    patched.source.slice(serverBranch, model).includes("attempt = 0"),
    true
  )
  const flash = patched.source.indexOf('"Fallback to Flash model failed:"')
  assert.equal(
    patched.source.slice(0, flash).split("codegPersistentFallbackAction")
      .length - 1,
    1
  )
  assert.equal(
    patched.source.slice(flash).includes("codegPersistentFallbackAction"),
    false
  )
})

test("unpatched ModelNotFound resets forever; the patch returns a tool error", async () => {
  const raw = await importSource("raw/core.js", fixture)
  assertUnpatched(await raw.runAll())
  const transformed = transformGeminiModule(fixture)
  assert.equal(transformed.changed, true)
  const patched = await importSource("patched/core.js", transformed.source)
  assertBounded(await patched.runAll())
})

test("loader applies the cap only inside official Gemini packages", () => {
  const register = pathToFileURL(
    path.join(path.dirname(new URL(import.meta.url).pathname), "register.mjs")
  ).href
  const cases = [
    ["@google/gemini-cli", true],
    ["@google/gemini-cli-core", true],
    ["other-tool", false],
  ]
  for (const [name, official] of cases) {
    const pkg = path.join(temporary, `pkg-${name.replaceAll("/", "-")}`)
    fs.mkdirSync(pkg, { recursive: true })
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name, type: "module" })
    )
    fs.writeFileSync(path.join(pkg, "core.js"), fixture)
    fs.writeFileSync(
      path.join(pkg, "main.mjs"),
      `import { runAll } from "./core.js"\nconsole.log(JSON.stringify(await runAll()))\n`
    )
    const env = { ...process.env }
    delete env.NODE_OPTIONS
    const result = spawnSync(
      process.execPath,
      ["--import", register, path.join(pkg, "main.mjs")],
      { encoding: "utf8", timeout: 20000, env }
    )
    assert.equal(result.status, 0, result.stderr)
    const output = JSON.parse(result.stdout)
    if (official) assertBounded(output)
    else assertUnpatched(output)
  }
})

const installedBundles = [
  "/opt/homebrew/lib/node_modules/@google/gemini-cli/bundle/chunk-UF44X63P.js",
  "/opt/homebrew/lib/node_modules/@google/gemini-cli/bundle/chunk-LMBUPWFC.js",
  "/opt/homebrew/lib/node_modules/@google/gemini-cli/bundle/chunk-37D3S3FZ.js",
].filter((file) => fs.existsSync(file))

test(
  "installed Gemini CLI bundles get one guarded flash fallback",
  { skip: installedBundles.length === 0, timeout: 120000 },
  () => {
    const packageFile = path.join(
      path.dirname(path.dirname(installedBundles[0])),
      "package.json"
    )
    const version = JSON.parse(fs.readFileSync(packageFile, "utf8")).version
    for (const file of installedBundles) {
      const source = fs.readFileSync(file, "utf8")
      const patched = patchModelNotFoundRetry(source)
      assert.equal(
        patched.patched,
        true,
        `${path.basename(file)} from Gemini ${version} no longer matches the flash fallback`
      )
      assert.equal(patched.count, 1)
      assert.equal(patchModelNotFoundRetry(patched.source).patched, false)
      const flash = patched.source.indexOf('"Fallback to Flash model failed:"')
      const model = patched.source.indexOf('"Model fallback failed:"')
      assert.equal(
        patched.source
          .slice(flash - 900, flash)
          .includes("codegPersistentFallbackAction"),
        true
      )
      assert.equal(
        patched.source
          .slice(model - 900, model)
          .includes("codegPersistentFallbackAction"),
        false
      )
    }
    const entry = installedBundles[0]
    const checked = path.join(temporary, "checked-bundle")
    fs.mkdirSync(checked, { recursive: true })
    fs.writeFileSync(
      path.join(checked, "package.json"),
      JSON.stringify({ type: "module" })
    )
    const output = path.join(checked, "chunk.js")
    fs.writeFileSync(
      output,
      transformGeminiModule(fs.readFileSync(entry, "utf8")).source
    )
    const syntax = spawnSync(process.execPath, ["--check", output], {
      encoding: "utf8",
      timeout: 60000,
    })
    assert.equal(syntax.status, 0, syntax.stderr)
  }
)
