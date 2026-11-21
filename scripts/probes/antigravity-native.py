#!/usr/bin/env python3
"""Offline upgrade probe: real agy ACP -> local Gemini SSE endpoint, no real key.
Run: python3 scripts/probes/antigravity-native.py [/absolute/path/to/agy]
"""
import asyncio
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile


async def probe(binary):
    requests = []
    key = "codeg-native-probe-not-a-real-key"

    async def endpoint(reader, writer):
        header = await reader.readuntil(b"\r\n\r\n")
        lines = header.decode().splitlines()
        headers = dict(line.lower().split(": ", 1) for line in lines[1:] if ": " in line)
        size = int(headers.get("content-length", "0"))
        if size:
            await reader.readexactly(size)
        requests.append((lines[0], key in header.decode()))
        response = {"candidates": [{"content": {"role": "model", "parts": [{"text": "native-endpoint-ok"}]}, "finishReason": "STOP"}], "usageMetadata": {"promptTokenCount": 1, "candidatesTokenCount": 1, "totalTokenCount": 2}}
        body = ("data: " + json.dumps(response) + "\n\n").encode()
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_server(endpoint, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    with tempfile.TemporaryDirectory(prefix="codeg-native-agy-") as work:
        root = Path(work)
        home = root / "home"
        home.mkdir()
        gemini = home / ".gemini"
        cli = gemini / "antigravity-cli"
        cli.mkdir(parents=True)
        (cli / "settings.json").write_text(json.dumps({"modelProvider": "gemini"}))
        env = {k: v for k, v in os.environ.items() if not k.startswith(("GEMINI", "GOOGLE", "AGY"))}
        env.update(HOME=str(home), USERPROFILE=str(home), XDG_CONFIG_HOME=str(home / ".config"), GEMINI_HOME=str(gemini), GEMINI_API_KEY=key, GOOGLE_GEMINI_BASE_URL=f"http://127.0.0.1:{port}", AGY_CLI_DISABLE_AUTO_UPDATE="true", NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost")
        process = await asyncio.create_subprocess_exec(binary, "acp", "--gemini-dir", str(gemini), "--app-data-dir", "antigravity-cli", stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, env=env, cwd=work)
        updates = []

        async def request(identifier, method, params):
            frame = {"jsonrpc": "2.0", "id": identifier, "method": method, "params": params}
            process.stdin.write((json.dumps(frame) + "\n").encode())
            await process.stdin.drain()
            while True:
                raw = await asyncio.wait_for(process.stdout.readline(), 45)
                if not raw:
                    raise RuntimeError("agy exited before answering " + method)
                try:
                    value = json.loads(raw)
                except ValueError:
                    continue
                if value.get("id") == identifier:
                    if "error" in value:
                        raise RuntimeError(method + " failed: " + str(value["error"].get("code")))
                    return value["result"]
                if value.get("method") == "session/update":
                    updates.append(value)
                elif "id" in value and "method" in value:
                    raise RuntimeError("Unexpected client request: " + value["method"])

        try:
            init = await request(1, "initialize", {"protocolVersion": 1, "clientCapabilities": {}, "clientInfo": {"name": "codeg-probe", "version": "1"}})
            await request(2, "authenticate", {"methodId": "gemini-api-key"})
            session = await request(3, "session/new", {"cwd": work, "mcpServers": []})
            await request(4, "session/prompt", {"sessionId": session["sessionId"], "prompt": [{"type": "text", "text": "Reply with native-endpoint-ok"}]})
            if not requests or not all("POST " in method and "GenerateContent" in method and authorized for method, authorized in requests):
                raise RuntimeError("Native model requests did not reach the configured endpoint with its API key")
            if not any("native-endpoint-ok" in json.dumps(update) for update in updates):
                raise RuntimeError("Mock Gemini response did not reach ACP session updates")
            print("PASS:", init["agentInfo"], "custom endpoint + key + streamed response")
            print("Native transcript formats:", sorted({path.suffix for path in cli.glob("conversations/**/*") if path.is_file()}))
        finally:
            process.stdin.close()
            try:
                await asyncio.wait_for(process.wait(), 3)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
            server.close()
            await server.wait_closed()


if __name__ == "__main__":
    executable = sys.argv[1] if len(sys.argv) > 1 else shutil.which("agy")
    if not executable:
        raise SystemExit("Install native agy first")
    asyncio.run(probe(executable))
