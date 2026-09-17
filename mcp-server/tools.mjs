// MCP tool catalogue. Every tool maps onto an existing BLEConsole command, so the MCP surface
// stays a thin adapter over behaviour that is already documented in the repo README.

const text = (s) => ({ content: [{ type: 'text', text: s }] });

/** Render a bridge result as a tool result, marking failures with isError. */
const fromResult = (res, { prefix } = {}) => {
  const body = res.error ? `ERROR: ${res.error}` : res.text;
  const out = prefix ? `${prefix}\n${body}` : body;
  const isError = !res.ok || res.exit !== 0;
  return isError
    ? { content: [{ type: 'text', text: out || 'Command failed.' }], isError: true }
    : text(out || '(no output)');
};

export const tools = [
  {
    name: 'ble_bridge_status',
    title: 'BLE bridge status',
    description:
      'Diagnostics for the BLEConsole bridge process itself: whether the bridge is running and ready, ' +
      'the resolved executable path, pending request count, exit code and recent stderr. ' +
      'Call this first if any other BLE tool fails unexpectedly.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async ({ bridge }) => {
      const s = bridge.status;
      const lines = [
        `executable : ${s.exePath}`,
        `running    : ${s.running}`,
        `ready      : ${s.ready}`,
        `pid        : ${s.pid}`,
        `pending    : ${s.pendingRequests}`,
        `spawnError : ${s.spawnError || '-'}`,
        `exitInfo   : ${s.exitInfo ? JSON.stringify(s.exitInfo) : '-'}`,
      ];
      if (s.stderrTail.length) lines.push('stderr tail:', ...s.stderrTail);
      return text(lines.join('\n'));
    },
  },

  {
    name: 'ble_list_devices',
    title: 'List BLE devices',
    description:
      'List Bluetooth LE devices Windows has seen recently (paired and unpaired, not all necessarily ' +
      'in range). The leading #NN is the index accepted by ble_open. Uses a cached device watcher, so ' +
      'a device that just powered on may take a few seconds to appear - call again to refresh.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async ({ bridge }) => {
      const res = await bridge.run('list');
      if (!res.ok || res.exit !== 0) return fromResult(res);
      const devices = res.lines
        .map((l) => /^#(\d+):\s+([0-9a-fA-F:]{17})\s*(.*)$/.exec(l))
        .filter(Boolean)
        .map((m) => ({ index: Number(m[1]), address: m[2], name: m[3].trim() || '(no advertising name)' }));
      if (!devices.length) return text('No BLE devices discovered yet. Wait a few seconds and retry.');
      const width = Math.max(...devices.map((d) => d.name.length), 4);
      const table = devices
        .map((d) => `#${String(d.index).padStart(2, '0')}  ${d.address}  ${d.name.padEnd(width)}`)
        .join('\n');
      return text(`${devices.length} device(s):\n${table}`);
    },
  },

  {
    name: 'ble_open',
    title: 'Connect to a BLE device',
    description:
      'Connect to a BLE device and enumerate its GATT services. Accepts the #NN index from ' +
      'ble_list_devices, a full/exact name, a unique name prefix, or a Bluetooth address. ' +
      'Pairing happens automatically during connect; supply pin only for devices that require one. ' +
      'Only one device can be connected at a time - this closes any previous connection.',
    inputSchema: {
      type: 'object',
      properties: {
        device: { type: 'string', description: 'Device index (#0), name, unique name prefix, or BT address.' },
        pin: { type: 'string', description: 'Optional pairing PIN, e.g. "123456".' },
      },
      required: ['device'],
      additionalProperties: false,
    },
    handler: async ({ bridge, args }) => {
      const target = args.pin ? `${args.device} ${args.pin}` : args.device;
      const res = await bridge.run('open', target);
      if (!res.ok || res.exit !== 0) {
        return fromResult(res, { prefix: `Could not open "${args.device}".` });
      }
      return fromResult(res, { prefix: `Connected to "${args.device}".` });
    },
  },

  {
    name: 'ble_close',
    title: 'Disconnect',
    description: 'Disconnect the current BLE device and drop all notification subscriptions.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async ({ bridge }) => fromResult(await bridge.run('close')),
  },

  {
    name: 'ble_status',
    title: 'Connection status',
    description:
      'Show the current session state: connected device, pairing state, available services, selected ' +
      'service and its characteristics. This is the cheapest way to re-orient after a context switch.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async ({ bridge }) => fromResult(await bridge.run('stat')),
  },

  {
    name: 'ble_services',
    title: 'List services',
    description: 'List the GATT services of the connected device with their #NN indices.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async ({ bridge }) => {
      const res = await bridge.run('stat');
      if (!res.ok || res.exit !== 0) return fromResult(res);
      const start = res.lines.findIndex((l) => /available services/i.test(l));
      if (start < 0) return text(res.text);
      const services = [];
      for (let i = start + 1; i < res.lines.length; i++) {
        const line = res.lines[i];
        const m = /^#(\d+):\s*(.*)$/.exec(line);
        if (!m) break;
        services.push(`#${m[1]}  ${m[2]}`);
      }
      return services.length
        ? text(`${services.length} service(s):\n${services.join('\n')}`)
        : text(res.text);
    },
  },

  {
    name: 'ble_select_service',
    title: 'Select service',
    description:
      'Select a service by its #NN index or name, which loads its characteristics so that ble_read, ' +
      'ble_write and ble_subscribe can address them by index or name.',
    inputSchema: {
      type: 'object',
      properties: { service: { type: 'string', description: 'Service index (#0) or service name.' } },
      required: ['service'],
      additionalProperties: false,
    },
    handler: async ({ bridge, args }) => fromResult(await bridge.run('set', args.service)),
  },

  {
    name: 'ble_characteristics',
    title: 'List characteristics',
    description:
      'List the characteristics of the currently selected service, with #NN indices and their property ' +
      'letters (R=read, W=write, N=notify, I=indicate). Select a service first with ble_select_service.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async ({ bridge }) => fromResult(await bridge.run('stat')),
  },

  {
    name: 'ble_read',
    title: 'Read characteristic',
    description:
      'Read the value of a characteristic and return it in the configured receive format(s). ' +
      'Accepts "#N", a characteristic name, or "service/characteristic". Omit the argument to read ' +
      'the characteristic selected via ble_subscribe/ble_status.',
    inputSchema: {
      type: 'object',
      properties: {
        characteristic: {
          type: 'string',
          description: 'Characteristic index (#0), name, or "service/characteristic". Optional.',
        },
      },
      additionalProperties: false,
    },
    handler: async ({ bridge, args }) =>
      fromResult(await bridge.run('read', args.characteristic || '')),
  },

  {
    name: 'ble_read_all',
    title: 'Read all characteristics',
    description: 'Read every characteristic in the selected service (or in an explicitly named service).',
    inputSchema: {
      type: 'object',
      properties: { service: { type: 'string', description: 'Optional service index (#0) or name.' } },
      additionalProperties: false,
    },
    handler: async ({ bridge, args }) => fromResult(await bridge.run('read-all', args.service || '')),
  },

  {
    name: 'ble_write',
    title: 'Write characteristic',
    description:
      'Write a value to a characteristic. The value string is interpreted using the current send ' +
      'format (default UTF8) - call ble_set_config with format="hex" first to send raw bytes such as ' +
      '"01 A0 FF". Use withoutResponse=true for fast writes that do not wait for an acknowledgement.',
    inputSchema: {
      type: 'object',
      properties: {
        characteristic: {
          type: 'string',
          description: 'Characteristic index (#0), name, or "service/characteristic".',
        },
        value: { type: 'string', description: 'Value to write, in the current send format.' },
        withoutResponse: {
          type: 'boolean',
          description: 'Write without response (-nr). Faster, but there is no delivery confirmation.',
        },
      },
      required: ['characteristic', 'value'],
      additionalProperties: false,
    },
    handler: async ({ bridge, args }) => {
      const prefix = args.withoutResponse ? '-nr ' : '';
      return fromResult(await bridge.run('write', `${prefix}${args.characteristic} ${args.value}`));
    },
  },

  {
    name: 'ble_subscribe',
    title: 'Subscribe to notifications',
    description:
      'Subscribe to value-change notifications (or indications) for a characteristic. Incoming values ' +
      'are pushed to this client as MCP log notifications on channel "ble/notification"; use ' +
      'ble_wait_notification to block for the next one instead. Requires a connected device.',
    inputSchema: {
      type: 'object',
      properties: {
        characteristic: {
          type: 'string',
          description: 'Characteristic index (#0), name, or "service/characteristic".',
        },
      },
      required: ['characteristic'],
      additionalProperties: false,
    },
    handler: async ({ bridge, args }) => fromResult(await bridge.run('subs', args.characteristic)),
  },

  {
    name: 'ble_unsubscribe',
    title: 'Unsubscribe',
    description: 'Unsubscribe from one characteristic, or from all of them when characteristic is omitted.',
    inputSchema: {
      type: 'object',
      properties: {
        characteristic: { type: 'string', description: 'Characteristic index/name, or omit for all.' },
      },
      additionalProperties: false,
    },
    handler: async ({ bridge, args }) => fromResult(await bridge.run('unsubs', args.characteristic || 'all')),
  },

  {
    name: 'ble_wait_notification',
    title: 'Wait for a notification',
    description:
      'Block until the next subscribed characteristic value arrives (or the connection timeout expires), ' +
      'then return the accumulated values. Handy for one-shot reads of a pushing characteristic. ' +
      'Prefer the push notifications for continuous streaming.',
    inputSchema: {
      type: 'object',
      properties: {
        timeoutSeconds: {
          type: 'number',
          description: 'Connection timeout applied while waiting, in seconds (1-59). Defaults to the session value.',
        },
      },
      additionalProperties: false,
    },
    handler: async ({ bridge, args, notifications }) => {
      if (typeof args.timeoutSeconds === 'number') {
        const t = Math.min(59, Math.max(1, Math.round(args.timeoutSeconds)));
        await bridge.run('timeout', String(t));
      }
      const mark = notifications.length;
      const res = await bridge.run('wait', '', { timeoutMs: 90000 });
      const newOnes = notifications.slice(mark);
      if (newOnes.length) {
        const body = newOnes.map((n) => `${n.char} (${n.len} bytes): ${n.data}`).join('\n');
        return text(body);
      }
      return res.text ? text(res.text) : text('No notification arrived within the timeout.');
    },
  },

  {
    name: 'ble_device_info',
    title: 'Device information',
    description:
      'Read the standard Device Information Service (manufacturer, model, firmware and software ' +
      'revision, serial number). Works without selecting a service.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async ({ bridge }) => fromResult(await bridge.run('device-info')),
  },

  {
    name: 'ble_pair',
    title: 'Pair / unpair',
    description:
      'Pair the currently connected device (optionally with a PIN), or remove the pairing when ' +
      'unpair=true. Most devices pair automatically during ble_open when a pin is supplied, so this is ' +
      'mainly for retrying pairing or for cleaning up. A device that only *displays* a random PIN ' +
      '(DisplayPin) is confirmed automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        pin: { type: 'string', description: 'PIN for devices that require one, e.g. "123456".' },
        unpair: { type: 'boolean', description: 'Remove the existing pairing instead of pairing.' },
      },
      additionalProperties: false,
    },
    handler: async ({ bridge, args }) => {
      if (args.unpair) return fromResult(await bridge.run('unpair'));
      const params = args.pin ? `mode=ProvidePin ${args.pin}` : '';
      return fromResult(await bridge.run('pair', params));
    },
  },

  {
    name: 'ble_list_descriptors',
    title: 'List descriptors',
    description: 'List the descriptors of a characteristic.',
    inputSchema: {
      type: 'object',
      properties: { characteristic: { type: 'string', description: 'Characteristic index, name, or service/char.' } },
      required: ['characteristic'],
      additionalProperties: false,
    },
    handler: async ({ bridge, args }) => fromResult(await bridge.run('desc', args.characteristic)),
  },

  {
    name: 'ble_read_descriptor',
    title: 'Read descriptor',
    description: 'Read a descriptor value, addressed as "<characteristic>/<descriptor>".',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'e.g. "#0/#0" or "NotifyChar/UserDescription".' } },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async ({ bridge, args }) => fromResult(await bridge.run('read-desc', args.path)),
  },

  {
    name: 'ble_write_descriptor',
    title: 'Write descriptor',
    description: 'Write a descriptor value, addressed as "<characteristic>/<descriptor>".',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'e.g. "#0/#0".' },
        value: { type: 'string', description: 'Value in the current send format.' },
      },
      required: ['path', 'value'],
      additionalProperties: false,
    },
    handler: async ({ bridge, args }) => fromResult(await bridge.run('write-desc', `${args.path} ${args.value}`)),
  },

  {
    name: 'ble_mtu',
    title: 'Show MTU',
    description: 'Show the negotiated ATT MTU size for the current connection.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async ({ bridge }) => fromResult(await bridge.run('mtu')),
  },

  {
    name: 'ble_set_config',
    title: 'Session configuration',
    description:
      'Change session-level settings. sendFormat controls how ble_write interprets values, ' +
      'receiveFormats controls how incoming data is rendered (comma separated, e.g. "hex,dec"), ' +
      'byteOrder applies to numeric conversions, connectionTimeout is used for open/read/wait.',
    inputSchema: {
      type: 'object',
      properties: {
        sendFormat: { type: 'string', enum: ['ASCII', 'UTF8', 'Dec', 'Hex', 'Bin'] },
        receiveFormats: {
          type: 'string',
          description: 'Comma separated subset of ASCII,UTF8,Dec,Hex,Bin - e.g. "UTF8,Hex".',
        },
        byteOrder: { type: 'string', enum: ['little', 'big'] },
        connectionTimeout: { type: 'number', description: 'Seconds, 1-59.' },
      },
      additionalProperties: false,
    },
    handler: async ({ bridge, args }) => {
      // Note: command names follow the aliases the console actually implements
      // (fmts / format_send, fmtr / format_receive) - the README's "format_rec" is not a command.
      const steps = [
        ['format_send', args.sendFormat],
        ['format_receive', args.receiveFormats],
        ['endian', args.byteOrder],
        ['timeout', typeof args.connectionTimeout === 'number' ? String(args.connectionTimeout) : null],
      ].filter(([, value]) => value !== undefined && value !== null && value !== '');

      if (!steps.length) return fromResult(await bridge.run('format'));

      const out = [];
      for (const [cmd, value] of steps) {
        const res = await bridge.run(cmd, value);
        if (!res.ok || res.exit !== 0) {
          return fromResult(res, { prefix: `Failed to apply ${cmd} ${value}:` });
        }
        out.push(res.text);
      }
      return text(out.filter(Boolean).join('\n'));
    },
  },

  {
    name: 'ble_raw',
    title: 'Raw BLEConsole command',
    description:
      'Escape hatch: run any BLEConsole command verbatim and return its raw output. Use this for ' +
      'commands without a dedicated tool (print, delay, foreach/if scripting) or when the dedicated ' +
      'tools are too narrow. The command name and arguments are passed through unchanged.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command name, e.g. "print" or "read-all".' },
        args: { type: 'string', description: 'Raw argument string passed as-is.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    handler: async ({ bridge, args }) => {
      const res = await bridge.run(args.command, args.args || '');
      return fromResult(res, { prefix: `> ${args.command} ${args.args || ''}`.trim() });
    },
  },
];
