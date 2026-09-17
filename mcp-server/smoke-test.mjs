#!/usr/bin/env node
// End-to-end smoke test: speaks MCP JSON-RPC to server.mjs over stdio, exactly like a client would.
//
//   node mcp-server/smoke-test.mjs
//
// Requires Windows with a Bluetooth adapter and BLEConsole.exe built (Release or Debug).

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, 'server.mjs');

const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let nextId = 1;
let failures = 0;
const asyncNotifications = [];

child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => process.stderr.write(`  [server] ${d}`));

createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.log(`  !! non-JSON on stdout: ${line.slice(0, 200)}`);
    failures++;
    return;
  }
  if (msg.id === undefined) {
    asyncNotifications.push(msg);
    return;
  }
  const entry = pending.get(msg.id);
  if (entry) {
    pending.delete(msg.id);
    entry(msg);
  }
});

function rpc(method, params, { timeoutMs = 60000 } = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${method} -> ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

function check(label, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures++;
  console.log(`  [${status}] ${label}${detail ? ` - ${detail}` : ''}`);
}

const firstLines = (result, n = 6) =>
  (result?.content?.[0]?.text || '').split('\n').slice(0, n).join(' | ');

try {
  console.log('\n== 1. handshake ==');
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '1.0.0' },
  });
  check('initialize returns protocolVersion', Boolean(init.protocolVersion), init.protocolVersion);
  check('serverInfo.name', init.serverInfo?.name === 'bleconsole-mcp', init.serverInfo?.name);
  notify('notifications/initialized', {});

  console.log('\n== 2. tools/list ==');
  const list = await rpc('tools/list', {});
  check('tools advertised', Array.isArray(list.tools) && list.tools.length > 0, `${list.tools?.length} tools`);
  check(
    'every tool has a JSON schema',
    list.tools.every((t) => t.name && t.description && t.inputSchema?.type === 'object'),
  );
  console.log(`  tools: ${list.tools.map((t) => t.name).join(', ')}`);

  console.log('\n== 3. tools/call ble_bridge_status ==');
  const status = await rpc('tools/call', { name: 'ble_bridge_status', arguments: {} });
  check('bridge_status did not error', !status.isError, firstLines(status, 4));
  await new Promise((r) => setTimeout(r, 1500)); // let the watcher populate

  console.log('\n== 4. tools/call ble_list_devices ==');
  const devices = await rpc('tools/call', { name: 'ble_list_devices', arguments: {} });
  const deviceText = devices?.content?.[0]?.text || '';
  check('list_devices returned content', deviceText.length > 0);
  check('list_devices not an error', !devices.isError, firstLines(devices, 3));

  console.log('\n== 5. tools/call ble_set_config (round trip) ==');
  const config = await rpc('tools/call', { name: 'ble_set_config', arguments: { receiveFormats: 'UTF8,Hex' } });
  const configText = config?.content?.[0]?.text || '';
  check('set_config ok', !config.isError, firstLines(config, 2));
  check('set_config did not hit an unknown command', !/Unknown command/i.test(configText), configText.trim());

  console.log('\n== 6. tools/call ble_status (no device connected expected) ==');
  const st = await rpc('tools/call', { name: 'ble_status', arguments: {} });
  check('status answered', Boolean(st?.content?.[0]?.text), firstLines(st, 2));

  console.log('\n== 7. tools/call ble_raw ==');
  const raw = await rpc('tools/call', { name: 'ble_raw', arguments: { command: 'mtu' } });
  check('raw escape hatch answered', Boolean(raw?.content?.[0]?.text), firstLines(raw, 2));

  console.log('\n== 8. unknown tool is reported, not crashed ==');
  const bogus = await rpc('tools/call', { name: 'does_not_exist', arguments: {} }).catch((e) => ({ error: e }));
  check('unknown tool rejected', Boolean(bogus.error) || bogus.isError, String(bogus.error?.message || '').slice(0, 80));

  console.log('\n== 9. ping ==');
  const pong = await rpc('ping', {});
  check('ping answers', pong !== undefined);

  // Optional real-device flow: set BLE_SMOKE_DEVICE to a name/index from ble_list_devices.
  const target = process.env.BLE_SMOKE_DEVICE;
  if (target) {
    console.log(`\n== 10. real device flow (${target}) ==`);
    const opened = await rpc('tools/call', { name: 'ble_open', arguments: { device: target } }, { timeoutMs: 90000 });
    const openedText = opened?.content?.[0]?.text || '';
    check('open succeeded', !opened.isError, openedText.split('\n').join(' | ').slice(0, 240));

    const services = await rpc('tools/call', { name: 'ble_services', arguments: {} });
    const servicesText = services?.content?.[0]?.text || '';
    check('services listed', /service\(s\)/.test(servicesText), servicesText.split('\n').slice(0, 4).join(' | '));

    const firstService = /^#(\d+)/m.exec(servicesText)?.[1];
    if (firstService !== undefined) {
      const sel = await rpc('tools/call', { name: 'ble_select_service', arguments: { service: `#${firstService}` } });
      check('select_service ok', !sel.isError, (sel?.content?.[0]?.text || '').split('\n')[0]);

      const chars = await rpc('tools/call', { name: 'ble_characteristics', arguments: {} });
      const charsText = chars?.content?.[0]?.text || '';
      check('characteristics listed', /#00/.test(charsText), charsText.split('\n').slice(0, 4).join(' | '));

      const readIndex = /^#(\d+):\s+\S+\s+R/m.exec(charsText)?.[1];
      if (readIndex !== undefined) {
        const read = await rpc('tools/call', { name: 'ble_read', arguments: { characteristic: `#${readIndex}` } });
        check('read returned a value', !read.isError, (read?.content?.[0]?.text || '').split('\n').join(' | ').slice(0, 160));
      } else {
        console.log('  [SKIP] no readable characteristic in the first service');
      }
    }

    const mtu = await rpc('tools/call', { name: 'ble_mtu', arguments: {} });
    check('mtu reported', !mtu.isError, (mtu?.content?.[0]?.text || '').split('\n')[0]);

    const closed = await rpc('tools/call', { name: 'ble_close', arguments: {} });
    check('close ok', !closed.isError, (closed?.content?.[0]?.text || '').split('\n')[0]);
  } else {
    console.log('\n  (set BLE_SMOKE_DEVICE=<name|#index> to also exercise a real device end to end)');
  }

  if (asyncNotifications.length) {
    console.log(`\n  (received ${asyncNotifications.length} async notification(s))`);
  }
} catch (err) {
  failures++;
  console.log(`\n  [FAIL] fatal: ${err.message}`);
} finally {
  console.log(failures === 0 ? '\nRESULT: all checks passed\n' : `\nRESULT: ${failures} check(s) failed\n`);
  try {
    child.stdin.end();
  } catch {
    /* ignore */
  }
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  // Never leave a stray bridge process behind.
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 500).unref();
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 3000);
}
