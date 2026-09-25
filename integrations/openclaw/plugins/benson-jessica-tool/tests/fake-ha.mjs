import http from 'node:http';

export function createSocketDriver(socketPath) {
  const request = (method, path, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ socketPath, path, method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} },
    (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    req.setTimeout(5_000, () => req.destroy(new Error('fake HA timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
  return {
    async read() {
      const response = await request('GET', '/api/states/vacuum.jesica_jesica');
      if (response.status !== 200) throw new Error('fake HA read failed');
      return response.body;
    },
    async dispatch(step) {
      const path = step.kind === 'setting' ? `/api/services/select/${step.name}` :
        `/api/services/vacuum/${step.operation}`;
      const response = await request('POST', path, step);
      return { accepted: response.status === 200 };
    },
  };
}

export async function startFakeHa(socketPath, mapFixture, behavior = {}) {
  let updatedMs = Date.now() - 2_000;
  let vacuumUpdatedMs = updatedMs;
  const settingUpdatedMs = { suction: updatedMs, mode: updatedMs, wetness: updatedMs };
  let reads = 0;
  const state = {
    status: { state: behavior.initialState ?? 'docked', activeSegments: Object.hasOwn(behavior, 'initialSegments') ? behavior.initialSegments : [],
      currentSegment: behavior.initialSegments?.[0] ?? null },
    taskId: behavior.noTaskId ? null : behavior.initialTaskId ?? null, taskScope: null,
    taskStatus: behavior.liveTaskSignals ? { state: 'completed', sourceUpdatedAt: new Date(updatedMs).toISOString() } : null,
    currentArea: behavior.currentArea ?? null,
    currentTime: behavior.currentTime ?? null,
    chargingStatus: behavior.chargingStatus ?? null,
    settings: { suction: 'standard', mode: 'sweeping', wetness: 2 },
    deviceSuction: 'standard',
    error: null, posts: [],
    ...(behavior.homeEvidence ? {
      taskDevice: { value: 0, sourceReadAt: new Date(updatedMs).toISOString() },
      homeGeometry: {
        sha256: 'de38293681d645b1b6ef43435140650b0857745e22beab905b2dbd4f2e69aa7c',
        mapId: mapFixture.mapId, deviceMapListReadAt: new Date(updatedMs).toISOString(),
        savedMapLoadedAt: new Date(updatedMs).toISOString(),
        visibleSegmentIds: mapFixture.rooms.map((room) => room.id),
        hiddenSegmentIds: [3, 9, 15, 17],
        noGoCount: 1, noMopCount: 0, virtualWallCount: 5,
      },
    } : {}),
  };
  const touch = () => {
    while (Date.now() <= updatedMs) { /* monotonic HA update timestamp */ }
    updatedMs = Date.now();
  };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/api/states/vacuum.jesica_jesica') {
      if (behavior.readUnavailable) { res.writeHead(503).end(); return; }
      reads++;
      const observedAt = new Date().toISOString();
      const map = structuredClone(mapFixture);
      if (reads >= behavior.mapChangeOnRead) map.rooms[0].name += ' changed';
      const body = {
        map: { ...map, observedAt },
        options: { observedAt, suction: ['quiet', 'standard', 'strong', 'turbo'],
          mode: ['sweeping', 'mopping'], wetness: { min: 2, max: 8, step: 2 } },
        status: { ...state.status, observedAt, sourceUpdatedAt: new Date(vacuumUpdatedMs).toISOString(),
          activeSegments: behavior.nullActiveSegments || (behavior.nullActiveSegmentsAfterPost && state.posts.length > 0) ?
            null : state.status.activeSegments },
        taskId: state.taskId, taskScope: state.taskScope, settings: { ...state.settings },
        deviceSuction: state.deviceSuction,
        settingSources: Object.fromEntries(Object.entries(settingUpdatedMs).map(([name, sourceUpdatedMs]) =>
          [name, { observedAt, sourceUpdatedAt: new Date(sourceUpdatedMs).toISOString() }])), error: state.error,
        taskStatus: state.taskStatus ? { ...state.taskStatus, observedAt } : null,
        ...(behavior.homeEvidence ? {
          taskDevice: structuredClone(state.taskDevice),
          homeGeometry: structuredClone(state.homeGeometry),
        } : {}),
        currentArea: state.currentArea ? { ...state.currentArea, observedAt } : null,
        currentTime: state.currentTime ? { ...state.currentTime, observedAt } : null,
        chargingStatus: state.chargingStatus ? { ...state.chargingStatus, observedAt } : null,
      };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      return;
    }
    if (req.method !== 'POST' || !req.url?.startsWith('/api/services/')) { res.writeHead(404).end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const step = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    state.posts.push(step);
    if (behavior.holdPostMs) await new Promise((resolve) => setTimeout(resolve, behavior.holdPostMs));
    if (!behavior.noTransition && !(step.kind === 'setting' && behavior.noTransitionFor === step.name)) {
      touch();
      if (step.kind === 'setting') {
        state.settings[step.name] = step.value;
        settingUpdatedMs[step.name] = updatedMs;
      } else if (step.operation === 'clean') {
        vacuumUpdatedMs = updatedMs;
        if (!behavior.staleDeviceSuction) state.deviceSuction = state.settings.suction;
        state.status.state = 'cleaning';
        state.status.activeSegments = behavior.wrongSegments ? [999] :
          step.targetKind === 'home' ? null : step.segments;
        state.status.currentSegment = state.status.activeSegments?.[0] ?? null;
        if (step.targetKind === 'home' && behavior.homeEvidence) {
          if (!behavior.noHomeMapRead) {
            state.homeGeometry.deviceMapListReadAt = new Date(updatedMs).toISOString();
          }
          if (!behavior.noHomeTaskTransition) {
            state.taskDevice = { value: behavior.wrongHomeTask ?? 1,
              sourceReadAt: new Date(updatedMs).toISOString() };
          }
          if (behavior.changedHomeDigest) state.homeGeometry.sha256 = 'f'.repeat(64);
        }
        state.taskId = behavior.noTaskId ? null : `fake-task-${state.posts.length}`;
        if (state.taskStatus && !behavior.noTaskStatusTransition) {
          state.taskStatus = { state: step.targetKind === 'home' ? 'auto_cleaning' : 'room_cleaning',
            sourceUpdatedAt: new Date(updatedMs).toISOString() };
        }
        state.taskScope = step.targetKind;
      } else if (step.operation === 'pause') {
        vacuumUpdatedMs = updatedMs; state.status.state = 'paused';
        if (state.taskStatus && !behavior.noTaskStatusTransition) {
          state.taskStatus = { state: 'room_cleaning_paused', sourceUpdatedAt: new Date(updatedMs).toISOString() };
        }
      }
      else if (step.operation === 'resume') { vacuumUpdatedMs = updatedMs; state.status.state = 'cleaning'; }
      else if (step.operation === 'stop') { vacuumUpdatedMs = updatedMs; state.status.state = 'stopped'; state.status.activeSegments = []; state.status.currentSegment = null; }
      else if (step.operation === 'dock') {
        vacuumUpdatedMs = updatedMs; state.status.state = behavior.dockArrives ? 'docked' : 'returning';
        if (behavior.dockArrives && state.chargingStatus && !behavior.noChargingTransition) {
          state.chargingStatus = { value: 'charging', sourceUpdatedAt: new Date(updatedMs).toISOString() };
        }
      }
    } else if (step.kind === 'setting' && behavior.settingValueWithoutSource) {
      state.settings[step.name] = step.value;
    }
    if (behavior.dropResponse) { req.socket.destroy(); return; }
    res.writeHead(behavior.rejectPost ? 500 : 200, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  return { state, close: () => new Promise((resolve) => server.close(resolve)) };
}
