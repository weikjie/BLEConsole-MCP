#!/usr/bin/env node
// MCP server exposing the BLEConsole command set to an agent over stdio.
//
// Transport : JSON-RPC 2.0, newline-delimited, on stdin/stdout (MCP stdio transport).
// Dependency-free on purpose - it only needs a Node runtime and the BLEConsole executable.
//
// It owns one long-lived BLEConsole child process (`BLEConsole.exe --mcp`) because the BLE
// connection, the selected service and the notification subscriptions all live in that process.

import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { Bridge } from './bridge.mjs';
import { tools } from './tools.mjs';

const NAME = 'bleconsole-mcp';
const VERSION = '1.0.0';

// Newest first: we answer with the client's version when we know it, else with our newest.
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
const NOTIFICATION_CHANNEL = 'ble/notification';
const MAX_NOTIFICATIONS = 200;
const NOTIFICATION_BATCH_MS = 150;

const here = dirname(fileURLToPath(import.meta.url));

function exists(p) {
  try {
    return Boolean(p) && existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Locate BLEConsole.exe. An explicit path wins, then the two conventional build output folders
 * (Release before Debug), then a copy dropped at the repository root.
 *
 * Build output is preferred deliberately: a release binary downloaded from GitHub predates the
 * --mcp transport and would silently treat protocol requests as console commands.
 */
function resolveBlePath() {
  const candidates = [];
  if (process.env.BLE_CONSOLE_PATH) candidates.push(process.env.BLE_CONSOLE_PATH);

  const repoRoot = resolve(here, '..');
  candidates.push(
    join(repoRoot, 'BLEConsole', 'bin', 'Release', 'BLEConsole.exe'),
    join(repoRoot, 'BLEConsole', 'bin', 'Debug', 'BLEConsole.exe'),
    join(repoRoot, 'BLEConsole.exe'),
  );

  for (const candidate of candidates) {
    if (exists(candidate)) return resolve(candidate);
  }

  throw new Error(
    'BLEConsole.exe not found. Build it first (see README) or set the BLE_CONSOLE_PATH ' +
      `environment variable to its full path. Searched: ${candidates.join(', ')}`,
  );
}

const write = (() => {
  let queue = Promise.resolve();
  return (msg) => {
    // stdout is the protocol channel: one JSON message per line, never interleaved.
    queue = queue.then(
      () =>
        new Promise((done) => {
          const ok = process.stdout.write(JSON.stringify(msg) + '\n');
          if (ok) done();
          else process.stdout.once('drain', done);
        }),
    );
    return queue;
  };
})();

const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
const replyError = (id, code, message, data) =>
  write({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });

// ---------------------------------------------------------------- bridge lifecycle

const notifications = [];
let blePath = null;
let pathError = null;
try {
  blePath = resolveBlePath();
} catch (err) {
  // Do not die here: the MCP handshake must succeed so the client can surface the real problem.
  pathError = err.message;
}

let bridge = null;

function getBridge() {
  if (pathError) throw new Error(pathError);
  if (!bridge) {
    bridge = new Bridge(blePath, {
      cwd: resolve(here, '..'),
      timeoutMs: Number(process.env.BLE_CONSOLE_TIMEOUT_MS) || 30000,
    });
    bridge.on('notification', queueNotification);
    bridge.on('log', (line) => process.stderr.write(`[bleconsole] ${line}\n`));
    bridge.on('exit', (info) => process.stderr.write(`[bleconsole] bridge exited: ${JSON.stringify(info)}\n`));
  }
  return bridge;
}

let flushTimer = null;

function queueNotification(note) {
  notifications.push(note);
  if (notifications.length > MAX_NOTIFICATIONS) notifications.shift();

  // Coalesce bursts: a fast notifying characteristic can otherwise flood the client.
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const batch = notifications.splice(0, notifications.length);
    if (!batch.length) return;
    const rendered = batch.map((n) => `${n.char} (${n.len} bytes): ${n.data}`).join('\n');
    void write({
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'info', logger: NAME, data: { channel: NOTIFICATION_CHANNEL, values: batch, text: rendered } },
    });
  }, NOTIFICATION_BATCH_MS);
  flushTimer.unref?.();
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (flushTimer) clearTimeout(flushTimer);
  try {
    bridge?.stop();
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(code), 200).unref();
}

// ---------------------------------------------------------------- MCP methods

const toolByName = new Map(tools.map((t) => [t.name, t]));

async function handleInitialize(params) {
  const requested = params?.protocolVersion;
  const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false }, logging: {} },
    serverInfo: { name: NAME, version: VERSION },
    instructions:
      'Controls Bluetooth LE devices on this Windows machine through BLEConsole. Typical flow: ' +
      'ble_list_devices -> ble_open -> ble_select_service -> ble_characteristics -> ble_read / ble_write. ' +
      'Subscribe with ble_subscribe to receive pushed values. Only one device can be connected at a time, ' +
      'and the connection is a session-wide resource shared by all tool calls.',
  };
}

async function handleToolsCall(params) {
  const name = params?.name;
  const args = params?.arguments || {};

  const tool = toolByName.get(name);
  if (!tool) return { __error: { code: -32602, message: `Unknown tool: ${name}` } };

  try {
    return await tool.handler({ bridge: getBridge(), args, notifications });
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text:
            `Tool "${name}" failed: ${err.message}\n` +
            'If the bridge process died, call ble_bridge_status for diagnostics.',
        },
      ],
      isError: true,
    };
  }
}

async function dispatch(method, params) {
  switch (method) {
    case 'initialize':
      return handleInitialize(params);
    case 'ping':
      return {};
    case 'tools/list':
      return {
        tools: tools.map(({ name, title, description, inputSchema }) => ({
          name,
          title,
          description,
          inputSchema,
        })),
      };
    case 'tools/call':
      return handleToolsCall(params);
    case 'logging/setLevel':
      return {};
    default: {
      const err = new Error(`Method not found: ${method}`);
      err.rpcCode = -32601;
      throw err;
    }
  }
}

// ---------------------------------------------------------------- main loop

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    void replyError(null, -32700, 'Parse error');
    return;
  }

  // Notifications from the client need no answer.
  if (msg.id === undefined || msg.id === null) return;

  void (async () => {
    try {
      const result = await dispatch(msg.method, msg.params);
      if (result && result.__error) {
        await replyError(msg.id, result.__error.code, result.__error.message);
      } else {
        await reply(msg.id, result);
      }
    } catch (err) {
      await replyError(msg.id, err.rpcCode || -32603, err.message || 'Internal error');
    }
  })();
});

rl.on('close', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', (err) => process.stderr.write(`[${NAME}] uncaught: ${err.stack}\n`));
process.on('unhandledRejection', (err) => process.stderr.write(`[${NAME}] unhandled: ${err}\n`));

process.stderr.write(
  `[${NAME}] v${VERSION} ready; ble executable = ${blePath || `NOT FOUND (${pathError})`}\n`,
);
