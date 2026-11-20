import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const inventoryTimeoutMs = 60_000;
const instanceArgs = ['emulator', 'list', '--details'];
const connectedArgs = ['device', 'list', '--format', 'json'];

function value(input) {
  return typeof input === 'string' ? input.trim() || undefined : undefined;
}

async function inventory(args, cwd, signal) {
  const command = 'devecocli ' + args.join(' ');
  const timeout = AbortSignal.timeout(inventoryTimeoutMs);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let stdout;
  try {
    const windows = process.platform === 'win32';
    // The Windows npm shim needs cmd.exe. Only the fixed inventory arguments enter its command string.
    ({stdout} = await execute(windows ? (process.env.ComSpec || 'cmd.exe') : 'devecocli',
      windows ? ['/d', '/s', '/c', command] : args, {
        cwd, signal: deadline, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
        env: {...process.env, DEVECO_CLI_DISABLE_UPDATE: 'check', DEVECO_CLI_DISABLE_TELEMETRY: '1'}
      }));
  } catch (error) {
    signal?.throwIfAborted();
    const reason = timeout.aborted ? '查询超时' : error.code === 'ENOENT' ? '命令不可用' : '查询失败';
    return {rows: [], error: `${command}：${reason}`};
  }
  try {
    const rows = JSON.parse(stdout.replace(/^\uFEFF/u, ''));
    if (Array.isArray(rows)) return {rows};
  } catch { /* Report malformed CLI output without including its contents. */ }
  return {rows: [], error: `${command}：返回的设备清单不是 JSON 数组`};
}

function emulatorProfile(row) {
  const name = value(row?.name) ?? value(row?.Name);
  if (!name) return;
  const model = value(row.productModel);
  const deviceType = value(row.deviceType) ?? value(row.DeviceType) ?? value(row.devicetype);
  const runningFlag = typeof row.isRunning === 'boolean' ? String(row.isRunning) : value(row.isRunning)?.toLowerCase();
  const running = ['true', 'false'].includes(runningFlag) ? runningFlag === 'true' : undefined;
  const port = row['hw.hdc.port'];
  const localPort = typeof port === 'number' || /^\d{1,5}$/u.test(value(port) ?? '') ? Number(port) : 0;
  const reportedSerial = running && Number.isInteger(localPort) && localPort > 0 && localPort <= 65535
    ? `127.0.0.1:${localPort}` : undefined;
  return {reportedSerial, device: {id: name, name, kind: 'emulator',
    ...(model && {model}), ...(deviceType && {deviceType}), ...(running !== undefined && {running})}};
}

function connectedDevice(row) {
  const serial = value(row?.serial);
  if (!serial || !['emulator', 'device'].includes(row.kind)) return;
  const name = value(row.name) ?? serial;
  const deviceType = value(row.deviceType);
  return {id: serial, name, serial, kind: row.kind, ...(deviceType && {deviceType}),
    ...(row.kind === 'emulator' && {running: true})};
}

export async function listEvaluationDevices(cwd, signal) {
  signal?.throwIfAborted();
  const [instances, connections] = await Promise.all([
    inventory(instanceArgs, cwd, signal), inventory(connectedArgs, cwd, signal)
  ]);
  signal?.throwIfAborted();
  const profiles = new Map(instances.rows.map(emulatorProfile).filter(Boolean).map(profile => [profile.device.id, profile]));
  const connected = new Map(connections.rows.map(connectedDevice).filter(Boolean).map(device => [device.serial, device]));
  const running = [...connected.values()].filter(device => device.kind === 'emulator');
  const byName = Map.groupBy(running, device => device.name);
  const reported = Map.groupBy([...profiles.values()].filter(profile => profile.reportedSerial), profile => profile.reportedSerial);
  const claimed = new Set();
  const devices = [];
  for (const {device, reportedSerial} of profiles.values()) {
    const named = byName.get(device.name);
    const byPort = connected.get(reportedSerial);
    const portAlias = byPort?.kind === 'emulator' && reported.get(reportedSerial)?.length === 1 &&
      (!profiles.has(byPort.name) || byPort.name === device.name) ? byPort : undefined;
    const live = named?.length === 1 ? named[0] : portAlias;
    if (live) {
      claimed.add(live.serial);
      devices.push({...live, ...device, running: true});
    } else {
      devices.push(device);
    }
  }
  devices.push(...[...connected.values()].filter(device => !claimed.has(device.serial)));
  return {devices, errors: [instances.error, connections.error].filter(Boolean)};
}
