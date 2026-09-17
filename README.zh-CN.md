# BLEConsole MCP server

[English](README.md) | **简体中文**

一个本地 [MCP](https://modelcontextprotocol.io) 服务端，把
[sensboston/BLEConsole](https://github.com/sensboston/BLEConsole)（Windows 上的蓝牙 LE 命令行工具）
开放给 AI Agent。Claude Desktop、Cursor、DSH 或任何 MCP 客户端，都能通过 22 个工具扫描、连接并读写
BLE 设备。

**零运行时依赖** —— 只需要 Node ≥ 18，以及一份从本仓库构建出来的 `BLEConsole.exe`。

> 📄 原版命令行文档在 **[README-BLEConsole.md](README-BLEConsole.md)**（英文）。

```
MCP 客户端 ──stdio/JSON-RPC──▶ server.mjs ──NDJSON──▶ BLEConsole.exe --mcp ──▶ WinRT 蓝牙 LE
```

## 为什么要用桥接，而不是简单包一层

BLE 连接、当前选中的服务、以及所有通知订阅，都是**进程内的状态**。如果每次工具调用都新起一个
`BLEConsole.exe`，就会反复重连设备、并悄悄丢掉全部订阅。所以服务端在整个会话期间只维持
**一条常驻子进程**。

该子进程以 `--mcp` 模式运行，这个模式把交互式 REPL 换成了按行分隔的 JSON 命令通道。命令集、BLE
逻辑、输出文本全部沿用控制台原有的那一套 —— 本服务端只是适配器，不是重新实现。

## 先构建可执行文件

MCP 服务端需要一份**从本仓库源码构建**的 `BLEConsole.exe`。从 GitHub 下载的 release 二进制早于
`--mcp` 通道，无法使用。

```powershell
msbuild BLEConsole\BLEConsole.csproj /p:Configuration=Release /p:Platform=AnyCPU
```

构建产物位于 `BLEConsole\bin\Release\BLEConsole.exe`。用 Visual Studio 的话，直接构建
`BLEConsole.sln` 即可。`.csproj` 会自动解析本机最新安装的 Windows SDK；如果构建仍然报错，参见仓库
根目录的 `compile_hint.txt`。

服务端按以下顺序查找可执行文件：

1. `$env:BLE_CONSOLE_PATH`
2. `BLEConsole/bin/Release/BLEConsole.exe`
3. `BLEConsole/bin/Debug/BLEConsole.exe`
4. 仓库根目录的 `BLEConsole.exe`

## 配置

### DSH

设置 → 插件 → MCP，或直接添加：

```
serverName : bleconsole
transport  : stdio
command    : node
args       : <仓库路径>\mcp-server\server.mjs
```

### Claude Desktop

配置文件 `%APPDATA%\Claude\claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "bleconsole": {
      "command": "node",
      "args": ["<仓库路径>\\mcp-server\\server.mjs"],
      "env": { "BLE_CONSOLE_PATH": "<仓库路径>\\BLEConsole\\bin\\Release\\BLEConsole.exe" }
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
      "args": ["<仓库路径>\\mcp-server\\server.mjs"]
    }
  }
}
```

环境变量：

| 变量 | 作用 |
| --- | --- |
| `BLE_CONSOLE_PATH` | `BLEConsole.exe` 的完整路径，会覆盖自动查找。 |
| `BLE_CONSOLE_TIMEOUT_MS` | 单条命令超时，默认 `30000`。 |

## 验证

```powershell
node mcp-server\smoke-test.mjs                      # 协议 + 设备发现
$env:BLE_SMOKE_DEVICE="你的设备名"; node mcp-server\smoke-test.mjs   # 追加真实设备的连接/读取/断开流程
```

## 工具

常规流程是
`ble_list_devices` → `ble_open` → `ble_select_service` → `ble_characteristics` → `ble_read` / `ble_write`。
凡是需要指定设备、服务或特征值的地方，**索引（`#0`）和名称都接受**。

| 工具 | 用途 |
| --- | --- |
| `ble_list_devices` | 列出 Windows 最近见过的设备，带 `#NN` 索引。 |
| `ble_open` | 连接并枚举 GATT 服务。会自动配对；设备要求 PIN 时传 `pin`。 |
| `ble_close` | 断开连接并清除全部订阅。 |
| `ble_status` | 当前设备、配对状态、已选中的服务/特征值。 |
| `ble_services` | 已连接设备的服务列表。 |
| `ble_select_service` | 选中某个服务（同时加载它的特征值）。 |
| `ble_characteristics` | 已选中服务的特征值，含属性字母（R/W/N/I）。 |
| `ble_read` / `ble_read_all` | 读取单个特征值 / 读取某服务下全部特征值。 |
| `ble_write` | 写入特征值；`withoutResponse: true` 为快速写入。 |
| `ble_subscribe` / `ble_unsubscribe` | 订阅 / 取消订阅通知。 |
| `ble_wait_notification` | 阻塞等待下一条推送值。 |
| `ble_device_info` | 标准 Device Information Service。 |
| `ble_pair` | 配对（可选 `pin`），或 `unpair: true` 解除配对。 |
| `ble_list_descriptors` / `ble_read_descriptor` / `ble_write_descriptor` | GATT 描述符。 |
| `ble_mtu` | 协商后的 ATT MTU。 |
| `ble_set_config` | 收发格式、字节序、连接超时。 |
| `ble_raw` | 逃生通道：原样执行任意控制台命令。 |
| `ble_bridge_status` | 桥接进程诊断 —— 出问题时**先调这个**。 |

### 通知

已订阅的值会以 MCP 日志通知推送给客户端，通道名为 `ble/notification`：

```json
{ "level": "info", "logger": "bleconsole-mcp",
  "data": { "channel": "ble/notification",
            "values": [{ "char": "…", "len": 4, "data": "hex:\t01 02 03 04" }] } }
```

突发通知按 150 ms 合并一次，避免高速通知的特征值把客户端刷爆。

## 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `did not answer the MCP handshake` | 该可执行文件早于 `--mcp` 通道 —— 重新构建，或修正 `BLE_CONSOLE_PATH`。 |
| `BLEConsole.exe not found` | 先构建，或设置 `BLE_CONSOLE_PATH`。 |
| 启动时报 `Access is denied` | 二进制带了「来自其他计算机」标记 —— 执行 `Unblock-File BLEConsole.exe`。 |
| `Timed out waiting for "open"` | 设备不在范围内或被占用；调大 `BLE_CONSOLE_TIMEOUT_MS`。 |
| 工具结果里出现 `Unknown command` | 该命令名不存在；对照控制台的 `help` 输出。 |

## 协议说明

`server.mjs` 与 `BLEConsole.exe --mcp` 之间的桥接线格式：

```jsonc
// 请求
{"id":1,"cmd":"read","args":"#0"}
// 响应
{"id":1,"ok":true,"exit":0,"lines":["Read 4 bytes.","hex: 01 02 03 04"]}
// 异步事件（无 id）
{"notify":"value","char":"…uuid…","len":4,"data":"hex: 01 02 03 04"}
```

`exit` 对应控制台的 ERRORLEVEL，因此 `ok:false` 或非零即表示命令失败。

## 许可

MIT，与上游 [BLEConsole](https://github.com/sensboston/BLEConsole) 项目一致 —— 见 [LICENSE](LICENSE)。
