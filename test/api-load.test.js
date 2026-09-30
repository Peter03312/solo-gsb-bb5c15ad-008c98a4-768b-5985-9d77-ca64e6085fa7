'use strict';

// 回路配置与负载分析的 HTTP API 集成测试。
// 每个测试文件使用独立的临时 SQLite 文件：在 require server 前设置 DB_PATH。
process.env.NODE_ENV = 'test';
process.env.DB_PATH = require('node:path').join(
  require('node:os').tmpdir(),
  `cue-load-api-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
);

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');

const app = require('../server.js');

let server;
let base;

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request(
      `${base}${url}`,
      {
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          const json = data ? JSON.parse(data) : null;
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// 建一条灯（可选电气属性），返回 {status, body}
const postLight = (name, extra = {}) => request('POST', '/api/lights', { name, ...extra });
const postCircuit = (name, capacity) => request('POST', '/api/circuits', { name, capacity });

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  for (const ext of ['', '-wal', '-shm']) {
    fs.rmSync(process.env.DB_PATH + ext, { force: true });
  }
});

test('回路：容量必须为严格正数，名称不能为空/重复', async () => {
  assert.equal((await postCircuit('A回路', 1000)).status, 201);
  let r = await postCircuit('零容量', 0);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /严格正数/);
  r = await postCircuit('负容量', -30);
  assert.equal(r.status, 400);
  r = await postCircuit('非数字', 'abc');
  assert.equal(r.status, 400);
  r = await postCircuit('', 10);
  assert.equal(r.status, 400);
  r = await postCircuit('A回路', 10);
  assert.equal(r.status, 409);
});

test('回路：可改名/改容量，非法整次拒绝', async () => {
  const c = (await request('GET', '/api/circuits')).body.find((x) => x.name === 'A回路');
  let r = await request('PATCH', `/api/circuits/${c.id}`, { capacity: 1200 });
  assert.equal(r.status, 200);
  assert.equal(r.body.capacity, 1200);
  r = await request('PATCH', `/api/circuits/${c.id}`, { capacity: 0 });
  assert.equal(r.status, 400);
  r = await request('PATCH', `/api/circuits/9999`, { capacity: 10 });
  assert.equal(r.status, 404);
});

test('灯具：分配回路必须带正数额定瓦数，引用不存在回路被拒，不部分保存', async () => {
  const c = (await request('GET', '/api/circuits')).body.find((x) => x.name === 'A回路');
  let r = await postLight('无瓦数灯', { circuit_id: c.id });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /额定瓦数/);
  r = await postLight('坏回路灯', { circuit_id: 9999, rated_watts: 500 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /回路不存在/);
  r = await postLight('零瓦灯', { circuit_id: c.id, rated_watts: 0 });
  assert.equal(r.status, 400);
  r = await postLight('负瓦灯', { circuit_id: c.id, rated_watts: -1 });
  assert.equal(r.status, 400);
  // 未分配回路、不填瓦数：允许（不计入负载）
  r = await postLight('普通灯');
  assert.equal(r.status, 201);
  assert.equal(r.body.circuit_id, null);
  assert.equal(r.body.rated_watts, null);
  // 正常分配
  r = await postLight('面光1', { circuit_id: c.id, rated_watts: 1000 });
  assert.equal(r.status, 201);
  assert.equal(r.body.circuit_id, c.id);
});

test('灯具 PATCH：改派/清空回路与瓦数校验', async () => {
  await postCircuit('B回路', 600);
  const circuits = (await request('GET', '/api/circuits')).body;
  const a = circuits.find((x) => x.name === 'A回路');
  const b = circuits.find((x) => x.name === 'B回路');
  const light = (await request('GET', '/api/lights')).body.find((x) => x.name === '面光1');

  let r = await request('PATCH', `/api/lights/${light.id}`, { circuit_id: b.id }); // 已有正瓦数
  assert.equal(r.status, 200);
  assert.equal(r.body.circuit_id, b.id);

  r = await request('PATCH', `/api/lights/${light.id}`, { rated_watts: null, circuit_id: null }); // 一起清空
  assert.equal(r.status, 200);
  assert.equal(r.body.circuit_id, null);

  r = await request('PATCH', `/api/lights/${light.id}`, { circuit_id: a.id }); // 无瓦数却分配
  assert.equal(r.status, 400);

  r = await request('PATCH', `/api/lights/${light.id}`, { circuit_id: a.id, rated_watts: 800 });
  assert.equal(r.status, 200);
});

test('回路删除：仍被灯具引用时 409', async () => {
  const a = (await request('GET', '/api/circuits')).body.find((x) => x.name === 'A回路');
  const r = await request('DELETE', `/api/circuits/${a.id}`);
  assert.equal(r.status, 409);
});

test('发布冻结回路配置；之后改草稿不影响已发布版本', async () => {
  const circuits = (await request('GET', '/api/circuits')).body;
  const a = circuits.find((x) => x.name === 'A回路');
  const lights = (await request('GET', '/api/lights')).body;
  const m = lights.find((x) => x.name === '面光1');

  // 一条 Cue：面光1 在 t=0 从 0 渐变到 100，用时 10
  const cue = await request('POST', '/api/cues', {
    light_id: m.id,
    time: 0,
    target: 100,
    duration: 10,
  });
  assert.equal(cue.status, 201);

  const v1 = await request('POST', '/api/versions', { label: '带电回路版' });
  assert.equal(v1.status, 201);
  assert.equal(v1.body.circuits.length, 2);
  const snapLight = v1.body.lights.find((l) => l.id === m.id);
  assert.equal(snapLight.circuit_id, a.id);
  assert.equal(snapLight.rated_watts, 800);
  const snapCirc = v1.body.circuits.find((c) => c.id === a.id);
  assert.equal(snapCirc.capacity, 1200); // 发布时容量被冻结

  // 发布后把草稿容量改小：版本快照不变
  const patched = await request('PATCH', `/api/circuits/${a.id}`, { capacity: 300 });
  assert.equal(patched.status, 200);
  const v1again = await request('GET', `/api/versions/${v1.body.id}`);
  assert.equal(v1again.body.circuits.find((c) => c.id === a.id).capacity, 1200);
});

test('GET /api/load：查看时刻负载与精确超载区间', async () => {
  const a = (await request('GET', '/api/circuits')).body.find((x) => x.name === 'A回路');
  // 找到冻结时容量为 1200 的那个版本（带电回路版）
  const versions = (await request('GET', '/api/versions')).body;
  const vid = versions.find((x) => x.label === '带电回路版').id;

  // 面光1（800W，已派 A回路）0→100 用 10：负载 = 8*t；容量 1200 → 全程不超载
  let r = await request('GET', `/api/load?version_id=${vid}&start=0&end=10&at=5`);
  assert.equal(r.status, 200);
  assert.equal(r.body.source.kind, 'version');
  const circ = r.body.circuits.find((c) => c.circuit_id === a.id);
  assert.ok(Math.abs(circ.load_at - 400) < 1e-6); // 50% × 800
  assert.equal(circ.overloaded_at, false);
  assert.deepEqual(circ.intervals, []);

  // 用 300 的容量阈值在另一条未改的回路无关——改为给 A 回路做小容量场景：
  // 直接以 capacity 不变的版本测交点：1200 不超，改测更小窗与 at=10（800W 仍不超）
  r = await request('GET', `/api/load?version_id=${vid}&start=0&end=10&at=10`);
  const c10 = r.body.circuits.find((c) => c.circuit_id === a.id);
  assert.ok(Math.abs(c10.load_at - 800) < 1e-6);
  assert.equal(c10.overloaded_at, false);
});

test('GET /api/load：多灯汇总超载，端点包含性正确', async () => {
  // 用当前草稿（A回路容量已改为 300）再发一版：面光1 已清空回路，先重新分配
  const circuits = (await request('GET', '/api/circuits')).body;
  const a = circuits.find((x) => x.name === 'A回路');
  const lights = (await request('GET', '/api/lights')).body;
  const m = lights.find((l) => l.name === '面光1');
  let r = await request('PATCH', `/api/lights/${m.id}`, { circuit_id: a.id, rated_watts: 1000 });
  assert.equal(r.status, 200);
  // Cue 仍在草稿（上一版发布后未改）：0→100 用 10，负载 100*t；容量 300 → t>3
  const v = await request('POST', '/api/versions', { label: '小容量版' });
  assert.equal(v.status, 201);

  r = await request('GET', `/api/load?version_id=${v.body.id}&start=0&end=10&at=5`);
  assert.equal(r.status, 200);
  const circ = r.body.circuits.find((c) => c.circuit_id === a.id);
  assert.ok(Math.abs(circ.load_at - 500) < 1e-6);
  assert.equal(circ.overloaded_at, true);
  assert.equal(circ.intervals.length, 1);
  assert.ok(Math.abs(circ.intervals[0].start - 3) < 1e-9);
  assert.equal(circ.intervals[0].start_inclusive, false); // 容量交点不含
  assert.equal(circ.intervals[0].end, 10);
  assert.equal(circ.intervals[0].end_inclusive, true);
  // t=3 恰好等于容量，不超载
  r = await request('GET', `/api/load?version_id=${v.body.id}&start=0&end=10&at=3`);
  assert.equal(r.body.circuits.find((c) => c.circuit_id === a.id).overloaded_at, false);
});

test('GET /api/load：参数校验（版本/记录不存在、时窗、非负）', async () => {
  let r = await request('GET', '/api/load?version_id=9999&start=0&end=10&at=5');
  assert.equal(r.status, 404);
  r = await request('GET', '/api/load?record_id=9999&start=0&end=10&at=5');
  assert.equal(r.status, 404);
  const versions = (await request('GET', '/api/versions')).body;
  const vid = versions[0].id;
  r = await request('GET', `/api/load?version_id=${vid}&start=10&end=0&at=5`);
  assert.equal(r.status, 400);
  r = await request('GET', `/api/load?version_id=${vid}&start=0&end=10&at=11`);
  assert.equal(r.status, 400);
  r = await request('GET', `/api/load?version_id=${vid}&start=-1&end=10&at=5`);
  assert.equal(r.status, 400);
  r = await request('GET', `/api/load?version_id=${vid}&start=abc&end=10&at=5`);
  assert.equal(r.status, 400);
  r = await request('GET', `/api/load?start=0&end=10&at=5`);
  assert.equal(r.status, 400);
});

test('POST /api/load：与 GET 同语义（JSON body）', async () => {
  const versions = (await request('GET', '/api/versions')).body;
  const vid = versions.find((v) => v.label === '小容量版').id;
  const r = await request('POST', '/api/load', {
    version_id: vid,
    start: 0,
    end: 10,
    at: 7,
  });
  assert.equal(r.status, 200);
  assert.ok(r.body.circuits.some((c) => c.overloaded_at));
});

test('调光记录负载：覆盖/归还叠加到回路，且不改变记录本身', async () => {
  // 自包含场景：专用回路容量 500，专用灯 1000W，原版只升到 20%（峰值 200W，全程不超载）
  const c = await postCircuit('记录专用回路', 500);
  assert.equal(c.status, 201);
  const l = await postLight('记录专用灯', { circuit_id: c.body.id, rated_watts: 1000 });
  assert.equal(l.status, 201);
  const cue = await request('POST', '/api/cues', {
    light_id: l.body.id,
    time: 0,
    target: 20,
    duration: 10,
  });
  assert.equal(cue.status, 201);
  const v = await request('POST', '/api/versions', { label: '记录负载版' });
  assert.equal(v.status, 201);
  const vid = v.body.id;

  const rec = await request('POST', '/api/records', { version_id: vid, label: '夜场临时' });
  assert.equal(rec.status, 201);
  const rid = rec.body.id;

  // 覆盖前：t=3 原版亮度 6%，负载 60W，不超载
  let r = await request('GET', `/api/load?record_id=${rid}&start=0&end=10&at=3`);
  assert.equal(r.status, 200);
  let circ = r.body.circuits.find((x) => x.circuit_id === c.body.id);
  assert.ok(Math.abs(circ.load_at - 60) < 1e-6);
  assert.equal(circ.overloaded_at, false);
  assert.deepEqual(circ.intervals, []);

  // t=4 覆盖立即到 100（1000W）：自该瞬间起严格超载
  const op = await request('POST', `/api/records/${rid}/ops`, {
    revision: 0,
    op: { light_id: l.body.id, time: 4, op_type: 'override', target: 100, duration: 0 },
  });
  assert.equal(op.status, 201);

  r = await request('GET', `/api/load?record_id=${rid}&start=0&end=10&at=6`);
  assert.equal(r.body.source.kind, 'record');
  assert.equal(r.body.source.record.id, rid);
  circ = r.body.circuits.find((x) => x.circuit_id === c.body.id);
  assert.ok(Math.abs(circ.load_at - 1000) < 1e-6);
  assert.equal(circ.overloaded_at, true);
  assert.equal(circ.intervals.length, 1);
  assert.equal(circ.intervals[0].start, 4);
  assert.equal(circ.intervals[0].start_inclusive, true); // 0 秒覆盖瞬间含
  assert.equal(circ.intervals[0].end, 10);
  assert.equal(circ.intervals[0].end_inclusive, true);

  // 记录接口语义不变
  const out = await request('GET', `/api/records/${rid}/output?at=6`);
  assert.equal(out.status, 200);
  assert.equal(out.body.levels.find((x) => x.light_id === l.body.id).actual, 100);
  const detail = await request('GET', `/api/records/${rid}`);
  assert.equal(detail.body.revision, 1);
  assert.ok(Array.isArray(detail.body.circuits)); // 详情附带冻结回路配置
});

test('负载分析只读：分析前后草稿、版本、记录均不变', async () => {
  const before = {
    lights: (await request('GET', '/api/lights')).body,
    cues: (await request('GET', '/api/cues')).body,
    versions: (await request('GET', '/api/versions')).body,
    records: (await request('GET', '/api/records')).body,
  };
  const vid = before.versions.find((v) => v.label === '小容量版').id;
  await request('POST', '/api/load', { version_id: vid, start: 0, end: 99, at: 50 });
  await request('GET', `/api/load?version_id=${vid}&start=0&end=10&at=5`);
  const after = {
    lights: (await request('GET', '/api/lights')).body,
    cues: (await request('GET', '/api/cues')).body,
    versions: (await request('GET', '/api/versions')).body,
    records: (await request('GET', '/api/records')).body,
  };
  assert.deepEqual(after, before);
});

test('旧版兼容：本功能上线前的版本（无回路）可分析但不产生负载', async () => {
  // 构造“旧版本”：清空所有回路分配并删除回路，使发布快照不含任何回路配置
  const circuits = (await request('GET', '/api/circuits')).body;
  for (const l of (await request('GET', '/api/lights')).body) {
    if (l.circuit_id !== null) {
      const r = await request('PATCH', `/api/lights/${l.id}`, {
        circuit_id: null,
        rated_watts: null,
      });
      assert.equal(r.status, 200);
    }
  }
  for (const c of circuits) {
    const r = await request('DELETE', `/api/circuits/${c.id}`);
    assert.equal(r.status, 204);
  }

  await postLight('旧灯');
  const oldLights = (await request('GET', '/api/lights')).body;
  const old = oldLights.find((l) => l.name === '旧灯');
  await request('POST', '/api/cues', { light_id: old.id, time: 0, target: 100, duration: 0 });
  const v = await request('POST', '/api/versions', { label: '无配置旧版' });
  // 该版本没有任何回路（灯全部未分配）
  const r = await request('GET', `/api/load?version_id=${v.body.id}&start=0&end=10&at=5`);
  assert.equal(r.status, 200);
  assert.equal(r.body.has_circuit_config, false);
  assert.deepEqual(r.body.circuits, []);
  assert.ok(r.body.unassigned_light_ids.includes(old.id));
  // 版本仍可播放（快照接口语义不变）
  const snap = await request('GET', `/api/versions/${v.body.id}`);
  assert.equal(snap.status, 200);
  assert.ok(snap.body.cues.some((c) => c.light_id === old.id));
});

