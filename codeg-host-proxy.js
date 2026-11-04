const net = require("node:net")
const fs = require("node:fs")

const listenHost = process.env.CODEG_HOST_PROXY_LISTEN_HOST || "127.0.0.1"
const listenPort = Number(process.env.CODEG_HOST_PROXY_LISTEN_PORT || 7890)
const targetHost = process.env.CODEG_HOST_PROXY_HOST || "host.docker.internal"
const targetPort = Number(process.env.CODEG_HOST_PROXY_PORT || 7890)
const readyFile = process.env.CODEG_HOST_PROXY_READY_FILE || "/tmp/codeg-host-proxy.ready"

const server = net.createServer((client) => {
  const upstream = net.connect(targetPort, targetHost)
  const closeBoth = () => {
    client.destroy()
    upstream.destroy()
  }

  client.on("error", closeBoth)
  upstream.on("error", closeBoth)
  client.pipe(upstream)
  upstream.pipe(client)
})

server.on("error", (error) => {
  console.error(`[codeg-host-proxy] ${error.message}`)
  process.exit(1)
})

server.listen(listenPort, listenHost, () => {
  fs.writeFileSync(readyFile, `${process.pid}\n`)
  console.log(
    `[codeg-host-proxy] ${listenHost}:${listenPort} -> ${targetHost}:${targetPort}`
  )
})
