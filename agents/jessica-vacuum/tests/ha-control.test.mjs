import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHaCanaryDriver } from '../lib/ha-control.mjs';

const map = JSON.parse(readFileSync(new URL('./fixtures/map-stage2-live.json', import.meta.url), 'utf8'));
const observedAt = map.observedAt;
const vacuum = {
  entity_id: 'vacuum.jesica_jesica', state: 'docked', last_updated: observedAt,
  attributes: {
    battery: 97, active_segments: null, current_segment: 8, has_error: false,
    suction_level: 'Standard',
    selected_map_id: map.mapId, selected_map: map.mapName,
    rooms: { [map.mapName]: map.rooms },
    shortcuts: Object.fromEntries(map.shortcuts.map((shortcut) => [String(shortcut.id), {
      id: shortcut.id, map_id: shortcut.mapId, tasks: shortcut.tasks,
    }])),
  },
};

test('HA canary driver reads task evidence and sends only the reviewed segment command', async () => {
  const calls = [];
  const driver = createHaCanaryDriver({ expectedSegmentId: 10,
    readState: async () => ({ state: vacuum, observedAt }),
    request: async (path, init) => {
      calls.push({ path, init });
      return path.startsWith('/api/states/') ? { ok: true, json: async () => ({
        entity_id: 'sensor.jesica_task_status', state: 'completed', last_updated: observedAt,
      }) } : { ok: true };
    },
  });
  const evidence = await driver.read();
  assert.equal(evidence.status.state, 'docked');
  assert.equal(evidence.status.activeSegments, null);
  assert.equal(evidence.taskStatus.state, 'completed');
  assert.equal(evidence.taskId, null);
  assert.equal(evidence.error, null);
  assert.equal(calls.length, 1);
  await assert.rejects(driver.dispatch({ kind: 'command', operation: 'clean', targetKind: 'rooms',
    segments: [8], workflowId: null }), /unapproved/);
  assert.equal(calls.length, 1);
  assert.deepEqual(await driver.dispatch({ kind: 'command', operation: 'clean', targetKind: 'rooms',
    segments: [10], workflowId: null }), { accepted: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].path, '/api/services/dreame_vacuum/vacuum_clean_segment');
  assert.deepEqual(JSON.parse(calls[1].init.body), { entity_id: 'vacuum.jesica_jesica', segments: 10 });
});

test('home driver projects device-confirmed task/map evidence and permits only vacuum.start', async () => {
  const calls = [];
  const homeVacuum = structuredClone(vacuum);
  homeVacuum.attributes.task_status_device_observation = { value: 0, source_read_at: observedAt };
  homeVacuum.attributes.selected_map_geometry_observation = {
    availability: 'available',
    sha256: 'de38293681d645b1b6ef43435140650b0857745e22beab905b2dbd4f2e69aa7c',
    map_id: 1, device_map_list_read_at: observedAt, saved_map_loaded_at: observedAt,
    visible_segment_ids: map.rooms.map((room) => room.id),
    hidden_segment_ids: [3, 9, 15, 17], no_go_count: 1, no_mop_count: 0, virtual_wall_count: 5,
  };
  const driver = createHaCanaryDriver({ expectedSegments: [], homeCanary: true,
    readState: async () => ({ state: homeVacuum, observedAt }),
    request: async (path, init) => {
      calls.push({ path, init });
      return path.startsWith('/api/states/') ? { ok: true, json: async () => ({
        entity_id: 'sensor.jesica_task_status', state: 'completed', last_updated: observedAt,
      }) } : { ok: true };
    },
  });
  const evidence = await driver.read();
  assert.equal(evidence.taskDevice.value, 0);
  assert.deepEqual(evidence.homeGeometry.hiddenSegmentIds, [3, 9, 15, 17]);
  assert.equal(evidence.homeGeometry.noGoCount, 1);
  assert.equal(evidence.homeGeometry.virtualWallCount, 5);
  await assert.rejects(driver.dispatch({ kind: 'command', operation: 'clean', targetKind: 'rooms',
    segments: [8], workflowId: null }), /unapproved/);
  await assert.rejects(driver.dispatch({ kind: 'setting', name: 'suction', value: 'strong' }), /unapproved/);
  await assert.rejects(driver.dispatch({ kind: 'command', operation: 'dock', targetKind: null,
    segments: [], workflowId: null }), /unapproved/);
  assert.equal(calls.filter((call) => call.init?.method === 'POST').length, 0);
  assert.deepEqual(await driver.dispatch({ kind: 'command', operation: 'clean', targetKind: 'home',
    segments: [], workflowId: null }), { accepted: true });
  const post = calls.find((call) => call.init?.method === 'POST');
  assert.equal(post.path, '/api/services/vacuum/start');
  assert.deepEqual(JSON.parse(post.init.body), { entity_id: 'vacuum.jesica_jesica' });
  assert.throws(() => createHaCanaryDriver({ expectedSegments: [], homeCanary: true,
    canarySuction: 'strong' }), /cannot share/);
  assert.throws(() => createHaCanaryDriver({ expectedSegments: [], homeCanary: true,
    controlOperation: 'pause' }), /cannot share/);
  const invalid = structuredClone(homeVacuum);
  invalid.attributes.selected_map_geometry_observation.hidden_segment_ids = [3, 9, 17, 17];
  const invalidDriver = createHaCanaryDriver({ expectedSegments: [], homeCanary: true,
    readState: async () => ({ state: invalid, observedAt }),
    request: async () => ({ ok: true, json: async () => ({
      entity_id: 'sensor.jesica_task_status', state: 'completed', last_updated: observedAt,
    }) }),
  });
  await assert.rejects(invalidDriver.read(), (error) => error.code === 'READ_INVALID');
});

test('HA driver preserves one reviewed multi-room set and rejects reordered or partial targets', async () => {
  const calls = [];
  const driver = createHaCanaryDriver({ expectedSegments: [8, 7],
    readState: async () => ({ state: vacuum, observedAt }),
    request: async (path, init) => {
      calls.push({ path, init });
      return path.startsWith('/api/states/') ? { ok: true, json: async () => ({
        entity_id: 'sensor.jesica_task_status', state: 'completed', last_updated: observedAt,
      }) } : { ok: true };
    },
  });
  await assert.rejects(driver.dispatch({ kind: 'command', operation: 'clean', targetKind: 'rooms',
    segments: [7, 8], workflowId: null }), /unapproved/);
  await assert.rejects(driver.dispatch({ kind: 'command', operation: 'clean', targetKind: 'rooms',
    segments: [8], workflowId: null }), /unapproved/);
  assert.equal(calls.length, 0);
  assert.deepEqual(await driver.dispatch({ kind: 'command', operation: 'clean', targetKind: 'rooms',
    segments: [8, 7], workflowId: null }), { accepted: true });
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    entity_id: 'vacuum.jesica_jesica', segments: [8, 7],
  });
});

test('HA canary driver fails closed on missing task status or device error', async () => {
  const driver = createHaCanaryDriver({ expectedSegmentId: 10,
    readState: async () => ({ state: vacuum, observedAt }),
    request: async () => ({ ok: true, json: async () => ({
      entity_id: 'sensor.jesica_task_status', state: 'completed', last_updated: 'invalid',
    }) }),
  });
  await assert.rejects(driver.read(), (error) => error.code === 'READ_INVALID');
  const errorDriver = createHaCanaryDriver({ expectedSegmentId: 10,
    readState: async () => ({ state: { ...vacuum, attributes: { ...vacuum.attributes, has_error: true } }, observedAt }),
    request: async () => ({ ok: true, json: async () => ({
      entity_id: 'sensor.jesica_task_status', state: 'completed', last_updated: observedAt,
    }) }),
  });
  assert.equal((await errorDriver.read()).error, 'DEVICE_ERROR_OR_UNKNOWN');
});

test('scoped suction driver reads selector evidence and permits only the reviewed setting', async () => {
  const calls = [];
  const driver = createHaCanaryDriver({ expectedSegmentId: 10, canarySuction: 'strong',
    readState: async () => ({ state: vacuum, observedAt }),
    request: async (path, init) => {
      calls.push({ path, init });
      if (path.endsWith('sensor.jesica_task_status')) return { ok: true, json: async () => ({
        entity_id: 'sensor.jesica_task_status', state: 'completed', last_updated: observedAt,
      }) };
      if (path.endsWith('select.jesica_suction_level')) return { ok: true, json: async () => ({
        entity_id: 'select.jesica_suction_level', state: 'standard', last_updated: observedAt,
        attributes: { options: ['quiet', 'standard', 'strong', 'turbo'] },
      }) };
      return { ok: true };
    },
  });
  const evidence = await driver.read();
  assert.equal(evidence.settings.suction, 'standard');
  assert.equal(evidence.deviceSuction, 'standard');
  assert.deepEqual(evidence.options.suction, ['quiet', 'standard', 'strong', 'turbo']);
  assert.equal(evidence.settingSources.suction.sourceUpdatedAt, observedAt);
  await assert.rejects(driver.dispatch({ kind: 'setting', name: 'suction', value: 'quiet' }), /unapproved/);
  await assert.rejects(driver.dispatch({ kind: 'setting', name: 'mode', value: 'sweeping' }), /unapproved/);
  assert.equal(calls.length, 2);
  assert.deepEqual(await driver.dispatch({ kind: 'setting', name: 'suction', value: 'strong' }), { accepted: true });
  assert.equal(calls[2].path, '/api/services/select/select_option');
  assert.deepEqual(JSON.parse(calls[2].init.body), { entity_id: 'select.jesica_suction_level', option: 'strong' });
  assert.deepEqual(await driver.dispatch({ kind: 'command', operation: 'clean', targetKind: 'rooms',
    segments: [10], workflowId: null }), { accepted: true });
});

test('scoped suction driver rejects missing or misleading selector evidence', async () => {
  const driver = createHaCanaryDriver({ expectedSegmentId: 10, canarySuction: 'strong',
    readState: async () => ({ state: vacuum, observedAt }),
    request: async (path) => ({ ok: true, json: async () => path.endsWith('sensor.jesica_task_status') ? {
      entity_id: 'sensor.jesica_task_status', state: 'completed', last_updated: observedAt,
    } : {
      entity_id: 'select.jesica_suction_level', state: 'standard', last_updated: observedAt,
      attributes: { options: ['quiet', 'standard'] },
    } }),
  });
  await assert.rejects(driver.read(), (error) => error.code === 'READ_INVALID');
});

test('pause and dock drivers read independent sensors and dispatch only reviewed controls', async () => {
  for (const operation of ['pause', 'dock']) {
    const calls = [];
    const driver = createHaCanaryDriver({ expectedSegmentId: 10, controlOperation: operation,
      readState: async () => ({ state: { ...vacuum, state: 'cleaning', attributes: {
        ...vacuum.attributes, active_segments: [10], current_segment: 10,
      } }, observedAt: new Date().toISOString() }),
      request: async (path, init) => {
        calls.push({ path, init });
        const entity_id = path.split('/').at(-1);
        if (path.startsWith('/api/states/')) return { ok: true, json: async () => ({
          entity_id, state: entity_id.endsWith('task_status') ? 'room_cleaning' :
            entity_id.endsWith('cleaned_area') ? '1' :
            entity_id.endsWith('cleaning_time') ? '2' : 'not_charging',
          last_updated: new Date(Date.now() - 1_000).toISOString(),
        }) };
        return { ok: true };
      },
    });
    const evidence = await driver.read();
    assert.equal(evidence.currentArea.value, 1);
    assert.equal(evidence.currentTime.value, 2);
    assert.equal(evidence.taskStatus.state, 'room_cleaning');
    assert.equal(evidence.chargingStatus?.value ?? null, operation === 'dock' ? 'not_charging' : null);
    const count = calls.length;
    await assert.rejects(driver.dispatch({ kind: 'command', operation, targetKind: null,
      workflowId: null, segments: [8] }), /unapproved/);
    assert.equal(calls.length, count);
    assert.deepEqual(await driver.dispatch({ kind: 'command', operation, targetKind: null,
      workflowId: null, segments: [10] }), { accepted: true });
    assert.equal(calls.at(-1).path, operation === 'pause' ? '/api/services/vacuum/pause' :
      '/api/services/vacuum/return_to_base');
  }
});

test('FC2 reviewed control allowlist dispatches one exact room and rejects pairs or other rooms', async () => {
  for (const operation of ['pause', 'dock']) {
    const calls = [];
    const driver = createHaCanaryDriver({ expectedSegments: [10, 7], controlOperation: operation,
      request: async (path, init) => { calls.push({ path, init }); return { ok: true }; } });
    const step = (segments) => ({ kind: 'command', operation, targetKind: null,
      workflowId: null, segments });
    await assert.rejects(driver.dispatch(step([8])), /unapproved/);
    await assert.rejects(driver.dispatch(step([10, 7])), /unapproved/);
    assert.equal(calls.length, 0);
    assert.deepEqual(await driver.dispatch(step([10])), { accepted: true });
    assert.deepEqual(await driver.dispatch(step([7])), { accepted: true });
    assert.equal(calls.length, 2);
  }
});

test('FC2 multi-room pause driver accepts only the exact canary set', async () => {
  const calls = [];
  const driver = createHaCanaryDriver({ expectedSegments: [8, 7, 10], controlOperation: 'pause',
    controlCanarySegments: [8, 7],
    request: async (path, init) => { calls.push({ path, init }); return { ok: true }; } });
  const step = (segments) => ({ kind: 'command', operation: 'pause', targetKind: null,
    workflowId: null, segments });
  for (const segments of [[8, 10], [8, 7, 10], [8, 8]]) {
    await assert.rejects(driver.dispatch(step(segments)), /unapproved/);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(await driver.dispatch(step([7, 8])), { accepted: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/services/vacuum/pause');
  assert.throws(() => createHaCanaryDriver({ expectedSegments: [8, 7], controlOperation: 'dock',
    controlCanarySegments: [8, 7] }), /reviewed multi-room pause/);
});

test('verified production multi-room pause pair is unordered and cannot widen', async () => {
  const calls = [];
  const driver = createHaCanaryDriver({ expectedSegments: [8, 7, 10], controlOperation: 'pause',
    controlVerifiedSets: [[8, 7]],
    request: async (path, init) => { calls.push({ path, init }); return { ok: true }; } });
  const step = (segments) => ({ kind: 'command', operation: 'pause', targetKind: null,
    workflowId: null, segments });
  for (const segments of [[8, 10], [8, 7, 10], [8, 8]]) {
    await assert.rejects(driver.dispatch(step(segments)), /unapproved/);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(await driver.dispatch(step([7, 8])), { accepted: true });
  assert.equal(calls.length, 1);
  assert.throws(() => createHaCanaryDriver({ expectedSegments: [8, 7], controlOperation: 'dock',
    controlVerifiedSets: [[8, 7]] }), /reviewed multi-room pause/);
});