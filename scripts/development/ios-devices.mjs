#!/usr/bin/env node
// 같은 이름이 여러 런타임에 있으면 추측하지 않고 UDID 지정을 요구한다.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export function availableIosDevices(catalog) {
  if (!catalog || typeof catalog.devices !== 'object' || catalog.devices === null || Array.isArray(catalog.devices)) {
    throw new Error('simctl did not return an iOS device catalog');
  }
  return Object.entries(catalog.devices).flatMap(([runtime, devices]) => {
    if (!runtime.startsWith('com.apple.CoreSimulator.SimRuntime.iOS-') || !Array.isArray(devices)) return [];
    return devices
      .filter(
        (device) =>
          device.isAvailable === true &&
          !device.availabilityError &&
          typeof device.name === 'string' &&
          typeof device.udid === 'string',
      )
      .map((device) => ({ name: device.name, udid: device.udid, runtime, state: device.state }));
  });
}

export function resolveIosDevice(catalog, requested) {
  const matches = availableIosDevices(catalog).filter(
    (device) => device.udid === requested || device.name === requested,
  );
  if (matches.length === 0) {
    throw new Error(
      `No available iOS Simulator matches "${requested}". Install its Xcode runtime and create the device; no substitute is selected.`,
    );
  }
  if (matches.length !== 1) {
    throw new Error(
      `Multiple iOS Simulators match "${requested}"; select a UDID: ${matches.map((device) => `${device.udid} (${device.runtime})`).join(', ')}`,
    );
  }
  return matches[0];
}

export async function readIosDeviceCatalog() {
  const { stdout } = await execute('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

if (import.meta.main) {
  readIosDeviceCatalog()
    .then((catalog) =>
      console.log(
        JSON.stringify(
          process.argv[2] ? resolveIosDevice(catalog, process.argv[2]) : availableIosDevices(catalog),
          null,
          2,
        ),
      ),
    )
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 2;
    });
}
