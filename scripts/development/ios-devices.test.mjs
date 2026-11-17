import assert from 'node:assert/strict';
import test from 'node:test';
import { availableIosDevices, resolveIosDevice } from './ios-devices.mjs';

const runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-27-1';
const duo = { name: 'iPhone Duo', udid: 'duo-runtime-one', isAvailable: true, state: 'Shutdown' };
const catalog = { devices: { [runtime]: [duo, { name: 'iPhone 17 Pro', udid: 'other', isAvailable: true }] } };

test('the requested Duo UDID is selected even when other simulators are available', () => {
  assert.equal(resolveIosDevice(catalog, duo.udid).name, 'iPhone Duo');
  assert.equal(resolveIosDevice(catalog, 'iPhone Duo').udid, duo.udid);
});

test('an unavailable Duo is not replaced with a conventional iPhone', () => {
  const unavailable = { devices: { [runtime]: [{ ...duo, isAvailable: false }, catalog.devices[runtime][1]] } };
  assert.throws(() => resolveIosDevice(unavailable, 'iPhone Duo'), /No available iOS Simulator/);
});

test('duplicate names across runtimes require an exact UDID', () => {
  const duplicate = {
    devices: {
      ...catalog.devices,
      'com.apple.CoreSimulator.SimRuntime.iOS-27-2': [{ ...duo, udid: 'duo-runtime-two' }],
    },
  };
  assert.throws(() => resolveIosDevice(duplicate, 'iPhone Duo'), /Multiple iOS Simulators/);
  assert.equal(resolveIosDevice(duplicate, 'duo-runtime-two').runtime, 'com.apple.CoreSimulator.SimRuntime.iOS-27-2');
});

test('other platforms and runtime errors are not executable iOS devices', () => {
  const filtered = {
    devices: {
      [runtime]: [{ ...duo, availabilityError: 'runtime missing' }],
      'com.apple.CoreSimulator.SimRuntime.tvOS-27-1': [duo],
    },
  };
  assert.deepEqual(availableIosDevices(filtered), []);
  assert.throws(() => availableIosDevices({}), /device catalog/);
});
