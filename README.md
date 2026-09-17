# BLEConsole MCP server

**English** | [简体中文](README.zh-CN.md)

A local [MCP](https://modelcontextprotocol.io) server that exposes
[sensboston/BLEConsole](https://github.com/sensboston/BLEConsole) — a Windows command-line tool for
Bluetooth LE — to AI agents. Claude Desktop, Cursor, DSH or any MCP client can scan, connect to and
talk to BLE devices through 22 tools.

Zero runtime dependencies — only Node ≥ 18 and a `BLEConsole.exe` built from this repository.

> 📄 The original command-line documentation lives in **[README-BLEConsole.md](README-BLEConsole.md)**.

```
MCP client ──stdio/JSON-RPC──▶ server.mjs ──NDJSON──▶ BLEConsole.exe --mcp ──▶ WinRT Bluetooth LE
```

## Why a bridge instead of a wrapper

The BLE connection, the selected service and the notification subscriptions are all state inside one
process. Spawning `BLEConsole.exe` per tool call would reconnect the device and silently drop every
subscription, so the server keeps **one long-lived child process** for the whole session.

The child runs in `--mcp` mode, which replaces the interactive REPL with a newline-delimited JSON
command channel. The command set, the BLE logic and the output text are exactly the ones the console
uses — this server is an adapter, not a reimplementation.

## Build the executable first

The MCP server needs a `BLEConsole.exe` built from this source tree. A release binary downloaded from
GitHub predates the `--mcp` transport and will not work.

```powershell
msbuild BLEConsole\BLEConsole.csproj /p:Configuration=Release /p:Platform=AnyCPU
```

Visual Studio users can just build `BLEConsole.sln`. The `.csproj` resolves the newest installed
Windows SDK automatically; see `compile_hint.txt` in the repository root if the build still complains.

The server looks for the executable in this order:

1. `$env:BLE_CONSOLE_PATH`
2. `BLEConsole/bin/Release/BLEConsole.exe`
3. `BLEConsole/bin/Debug/BLEConsole.exe`
4. `BLEConsole.exe` at the repository root

## Configuration

### DSH

Settings → Plugins → MCP, or add it directly (project level writes `.dsh/`):

```
serverName : bleconsole
transport  : stdio
command    : node
args       : <repo>\mcp-server\server.mjs
```

### Claude Desktop

`%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bleconsole": {
      "command": "node",
      "args": ["<repo>\\mcp-server\\server.mjs"],
      "env": { "BLE_CONSOLE_PATH": "<repo>\\BLEConsole\\bin\\Release\\BLEConsole.exe" }
    }
  }
}
```

### Cursor / VS Code

```json
{
  "mcpServers": {
    "bleconsole": {
      "command": "node",
      "args": ["<repo>\\mcp-server\\server.mjs"]
    }
  }
}
```

Environment variables:

| Variable | Purpose |
| --- | --- |
| `BLE_CONSOLE_PATH` | Full path to `BLEConsole.exe`. Overrides auto-discovery. |
| `BLE_CONSOLE_TIMEOUT_MS` | Per-command timeout, default `30000`. |

## Verify

```powershell
node mcp-server\smoke-test.mjs                      # protocol + device discovery
$env:BLE_SMOKE_DEVICE="YourDevice"; node mcp-server\smoke-test.mjs   # adds a real connect/read/close flow
```

## Tools

`ble_list_devices` → `ble_open` → `ble_select_service` → `ble_characteristics` → `ble_read` / `ble_write`
is the normal flow. Indices (`#0`) and names are both accepted wherever a device, service or
characteristic is expected.

| Tool | Purpose |
| --- | --- |
| `ble_list_devices` | Devices Windows has seen recently, with the `#NN` index. |
| `ble_open` | Connect + enumerate GATT services. Auto-pairs; pass `pin` if the device demands one. |
| `ble_close` | Disconnect and drop subscriptions. |
| `ble_status` | Current device, pairing state, selected service/characteristic. |
| `ble_services` | Services of the connected device. |
| `ble_select_service` | Select a service (loads its characteristics). |
| `ble_characteristics` | Characteristics of the selected service, with property letters. |
| `ble_read` / `ble_read_all` | Read one characteristic / every characteristic in a service. |
| `ble_write` | Write a characteristic; `withoutResponse: true` for fast writes. |
| `ble_subscribe` / `ble_unsubscribe` | Notification subscriptions. |
| `ble_wait_notification` | Block for the next pushed value. |
| `ble_device_info` | Standard Device Information Service. |
| `ble_pair` | Pair (optional `pin`) or `unpair: true`. |
| `ble_list_descriptors` / `ble_read_descriptor` / `ble_write_descriptor` | GATT descriptors. |
| `ble_mtu` | Negotiated ATT MTU. |
| `ble_set_config` | Send/receive formats, byte order, connection timeout. |
| `ble_raw` | Escape hatch: run any console command verbatim. |
| `ble_bridge_status` | Bridge process diagnostics — call this first when something misbehaves. |

### Notifications

Subscribed values are pushed to the client as MCP log notifications on channel `ble/notification`:

```json
{ "level": "info", "logger": "bleconsole-mcp",
  "data": { "channel": "ble/notification",
            "values": [{ "char": "…", "len": 4, "data": "hex:\t01 02 03 04" }] } }
```

Bursts are coalesced every 150 ms so a fast characteristic cannot flood the client.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `did not answer the MCP handshake` | The executable predates `--mcp` — rebuild, or fix `BLE_CONSOLE_PATH`. |
| `BLEConsole.exe not found` | Build it, or set `BLE_CONSOLE_PATH`. |
| `Access is denied` on launch | The binary carries a mark-of-the-web — run `Unblock-File BLEConsole.exe`. |
| `Timed out waiting for "open"` | Device out of range or busy; raise `BLE_CONSOLE_TIMEOUT_MS`. |
| `Unknown command` in a tool result | That command name does not exist; check the console `help` output. |

## Protocol reference

Bridge wire format between `server.mjs` and `BLEConsole.exe --mcp`:

```jsonc
// request
{"id":1,"cmd":"read","args":"#0"}
// response
{"id":1,"ok":true,"exit":0,"lines":["Read 4 bytes.","hex: 01 02 03 04"]}
// asynchronous event (no id)
{"notify":"value","char":"…uuid…","len":4,"data":"hex: 01 02 03 04"}
```

`exit` mirrors the console's ERRORLEVEL, so `ok:false`/non-zero marks a failed command.

## License

MIT, same as the upstream [BLEConsole](https://github.com/sensboston/BLEConsole) project — see
[LICENSE](LICENSE).
