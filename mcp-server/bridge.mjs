// Bridge to a long-lived BLEConsole.exe --mcp child process.
//
// The child owns all BLE state (connection, service selection, subscriptions), so it must stay
// alive for the whole session - spawning one process per tool call would drop subscriptions and
// reconnect the device every time.
//
// Wire format (newline-delimited JSON):
//   -> {"id":1,"cmd":"read","args":"#0"}
//   <- {"id":1,"ok":true,"exit":0,"lines":[...]}          response
//   <- {"notify":"value","char":"...","data":"..."}       asynchronous GATT notification

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

const DEFAULT_TIMEOUT_MS = 30000;
const HANDSHAKE_TIMEOUT_MS = 8000;
const MAX_BUFFER_BYTES = 1024 * 1024;

export class Bridge extends EventEmitter {
  #child = null;
  #rl = null;
  #nextId = 1;
  #pending = new Map();
  #stderr = [];
  #ready = false;
  #exitInfo = null;
  #spawnError = null;

  constructor(exePath, options = {}) {
    super();
    this.exePath = exePath;
    this.cwd = options.cwd || undefined;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  get isRunning() {
    return this.#child !== null && this.#child.exitCode === null && !this.#child.killed;
  }

  get ready() {
    return this.#ready && this.isRunning;
  }

  /** Diagnostics for the ble_bridge_status tool. */
  get status() {
    return {
      exePath: this.exePath,
      running: this.isRunning,
      ready: this.#ready,
      pid: this.#child ? this.#child.pid : null,
      exitCode: this.#child ? this.#child.exitCode : null,
      pendingRequests: this.#pending.size,
      spawnError: this.#spawnError,
      exitInfo: this.#exitInfo,
      stderrTail: this.#stderr.slice(-20),
    };
  }

  start() {
    if (this.isRunning) return this;

    this.#spawnError = null;
    this.#exitInfo = null;
    this.#ready = false;

    let child;
    try {
      child = spawn(this.exePath, ['--mcp'], {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      this.#spawnError = err.message;
      throw new Error(`Failed to launch ${this.exePath}: ${err.message}`);
    }

    this.#child = child;

    child.on('error', (err) => {
      this.#spawnError = err.message;
      this.#failAll(new Error(`BLEConsole process error: ${err.message}`));
    });

    child.on('exit', (code, signal) => {
      this.#exitInfo = { code, signal };
      this.#ready = false;
      this.#failAll(new Error(`BLEConsole exited (code=${code}, signal=${signal})`));
      this.emit('exit', this.#exitInfo);
    });

    // stderr is diagnostics only - never part of the protocol.
    this.#rl = createInterface({ input: child.stderr, crlfDelay: Infinity });
    this.#rl.on('line', (line) => {
      this.#stderr.push(line);
      if (this.#stderr.length > 200) this.#stderr.shift();
      this.emit('log', line);
    });

    let buffered = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffered += chunk;
      if (buffered.length > MAX_BUFFER_BYTES) {
        buffered = '';
        this.emit('log', 'protocol buffer overflow - discarding');
        return;
      }
      let idx;
      while ((idx = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, idx);
        buffered = buffered.slice(idx + 1);
        if (line.trim()) this.#handleLine(line);
      }
    });

    return this;
  }

  #handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // Not protocol data (shouldn't happen) - surface it instead of dying.
      this.emit('log', `non-JSON output: ${line}`);
      return;
    }

    if (msg.ready) {
      this.#ready = true;
      this.emit('ready', msg);
      return;
    }

    if (msg.notify) {
      this.emit('notification', msg);
      return;
    }

    const entry = this.#pending.get(msg.id);
    if (!entry) {
      this.emit('log', `unmatched response id=${msg.id}`);
      return;
    }
    this.#pending.delete(msg.id);
    clearTimeout(entry.timer);
    entry.resolve(msg);
  }

  #failAll(err) {
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.#pending.clear();
  }

  /** Send one command and resolve with the raw bridge response. */
  async send(cmd, args = '', { timeoutMs } = {}) {
    if (!this.isRunning) this.start();
    if (!this.isRunning) {
      throw new Error(`BLEConsole is not running: ${this.#spawnError || 'unknown reason'}`);
    }

    await this.#waitReady();

    const id = this.#nextId++;
    const payload = JSON.stringify({ id, cmd, args: args == null ? '' : String(args) });
    const limit = timeoutMs || this.timeoutMs;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timed out after ${limit}ms waiting for "${cmd}". The device may be out of range or unresponsive.`));
      }, limit);

      this.#pending.set(id, { resolve, reject, timer });

      try {
        this.#child.stdin.write(payload + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new Error(`Failed to write to BLEConsole: ${err.message}`));
      }
    });
  }

  /**
   * Wait for the child's {"ready":true} banner. Without this, a binary that predates the --mcp
   * transport would just print "Unknown command" for every request and look like a hang.
   */
  #waitReady() {
    if (this.#ready) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const settle = (fn, arg) => {
        clearTimeout(timer);
        this.off('ready', onReady);
        this.off('exit', onExit);
        fn(arg);
      };
      const onReady = () => settle(resolve);
      const onExit = (info) => settle(reject, new Error(`BLEConsole exited during handshake: ${JSON.stringify(info)}`));
      const timer = setTimeout(() => {
        settle(
          reject,
          new Error(
            `${this.exePath} did not answer the MCP handshake within ${HANDSHAKE_TIMEOUT_MS}ms. ` +
              'This build probably predates the --mcp transport - rebuild BLEConsole, or point ' +
              'BLE_CONSOLE_PATH at a binary built from this source tree.',
          ),
        );
      }, HANDSHAKE_TIMEOUT_MS);

      this.once('ready', onReady);
      this.once('exit', onExit);
    });
  }

  /** Send a command and flatten the response into { ok, exit, lines, error, text }. */
  async run(cmd, args = '', options) {
    const res = await this.send(cmd, args, options);
    const lines = Array.isArray(res.lines) ? res.lines : [];
    return {
      ok: res.ok !== false,
      exit: typeof res.exit === 'number' ? res.exit : 0,
      lines,
      error: res.error || null,
      text: lines.join('\n'),
    };
  }

  stop() {
    if (!this.#child) return;
    const child = this.#child;
    this.#child = null;
    try {
      if (child.exitCode === null) {
        try { child.stdin.write(JSON.stringify({ id: 0, cmd: 'quit' }) + '\n'); } catch { /* ignore */ }
        setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 300).unref();
      }
    } catch { /* ignore */ }
    this.#failAll(new Error('Bridge stopped'));
  }
}
