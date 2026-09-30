'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../public/engine.js');

const IV = (start, end, start_inclusive, end_inclusive) => ({
  start,
  end,
  start_inclusive,
  end_inclusive,
});

/**
 * 便捷构造：
 *  members: [[light_id, rated_watts], ...]
 *  cueRows / ops 直接喂给引擎
 */
function overload({ cues = [], ops = [], members, capacity, start, end }) {
  const base = Engine.prepareCues(cues);
  const byLight = Engine.prepareOverrides(ops, base);
  return Engine.overloadIntervals(
    base,
    byLight,
    members.map(([id, w]) => ({ light_id: id, rated_watts: w })),
    capacity,
    start,
    end
  );
}

function loadAt({ cues = [], ops = [], members, at }) {
  const base = Engine.prepareCues(cues);
  const byLight = Engine.prepareOverrides(ops, base);
  let sum = 0;
  for (const [id, w] of members) {
    sum += (Engine.overrideBrightnessAt(byLight, base, id, at) / 100) * w;
  }
  return sum;
}

test('单灯线性渐变：容量交点为开端点，窗右端闭合', () => {
  // #1 额定 1000W，0→100 用 10s；负载 = 100*t。容量 400 → t > 4 超载
  const cues = [{ cue_no: 1, light_id: 1, time: 0, target: 100, duration: 10 }];
  assert.deepEqual(overload({ cues, members: [[1, 1000]], capacity: 400, start: 0, end: 10 }), [
    IV(4, 10, false, true),
  ]);
});

test('负载恰好等于容量不超载（严格大于）', () => {
  const cues = [{ cue_no: 1, light_id: 1, time: 0, target: 60, duration: 6 }];
  // 60% × 1000W = 600W 为终点；容量 600 全程不严格超出
  assert.deepEqual(overload({ cues, members: [[1, 1000]], capacity: 600, start: 0, end: 6 }), []);
  // 容量 599.999：交点 5.9999 开、右端 6 闭
  const got = overload({ cues, members: [[1, 1000]], capacity: 599.999, start: 0, end: 6 });
  assert.equal(got.length, 1);
  assert.ok(Math.abs(got[0].start - 5.99999) < 1e-9);
  assert.equal(got[0].start_inclusive, false);
  assert.equal(got[0].end, 6);
  assert.equal(got[0].end_inclusive, true);
});

test('瞬变：触发瞬间跳到超载，区间自闭端点开始', () => {
  // t=4 瞬变到 100（1000W），容量 500 → [4,10]
  const cues = [{ cue_no: 1, light_id: 1, time: 4, target: 100, duration: 0 }];
  assert.deepEqual(overload({ cues, members: [[1, 1000]], capacity: 500, start: 0, end: 10 }), [
    IV(4, 10, true, true),
  ]);
});

test('时窗右端恰为瞬变时刻：闭单点 [t,t] 表示仅该瞬间超载', () => {
  const cues = [{ cue_no: 1, light_id: 1, time: 4, target: 100, duration: 0 }];
  assert.deepEqual(overload({ cues, members: [[1, 1000]], capacity: 500, start: 0, end: 4 }), [
    IV(4, 4, true, true),
  ]);
});

test('中途接管：峰形负载两段斜线精确切分', () => {
  // 0→100 用 10，t=5（亮度 50）接管渐变到 0 用 5；
  // 负载 1000W 灯：[0,5] 100t，[5,10] 1000-100(t-5)=1500-100t。容量 400 → (4,6)
  const cues = [
    { cue_no: 1, light_id: 1, time: 0, target: 100, duration: 10 },
    { cue_no: 2, light_id: 1, time: 5, target: 0, duration: 5 },
  ];
  assert.deepEqual(overload({ cues, members: [[1, 1000]], capacity: 400, start: 0, end: 10 }), [
    IV(4, 6, false, false),
  ]);
});

test('多灯回路：负载按 亮度/100×额定瓦数 汇总，同时刻瞬变合并', () => {
  // #1 恒亮 40（500W → 200W），#2 0→100 用 10（1000W → 100t）。
  // 合计 200 + 100t；容量 600 → t > 4
  const cues = [
    { cue_no: 1, light_id: 1, time: 0, target: 40, duration: 0 },
    { cue_no: 2, light_id: 2, time: 0, target: 100, duration: 10 },
  ];
  const members = [[1, 500], [2, 1000]];
  assert.deepEqual(overload({ cues, members, capacity: 600, start: 0, end: 10 }), [
    IV(4, 10, false, true),
  ]);
  assert.ok(Math.abs(loadAt({ cues, members, at: 5 }) - 700) < 1e-9);
});

test('查看时刻负载数值正确', () => {
  const cues = [{ cue_no: 1, light_id: 1, time: 0, target: 80, duration: 8 }];
  // t=4 亮度 40 → 40%×2000 = 800W
  assert.ok(Math.abs(loadAt({ cues, members: [[1, 2000]], at: 4 }) - 800) < 1e-9);
});

test('覆盖保持改变回路负载：0 秒覆盖立即生效', () => {
  // 原版恒 0；t=3 覆盖到 80（1000W 灯 → 800W）并保持；容量 500 → [3,10]
  const cues = [];
  const ops = [{ seq: 1, light_id: 1, time: 3, op_type: 'override', target: 80, duration: 0 }];
  assert.deepEqual(
    overload({ cues, ops, members: [[1, 1000]], capacity: 500, start: 0, end: 10 }),
    [IV(3, 10, true, true)]
  );
});

test('归还融合：实际输出为二次函数，精确求出短时超载区间（不采样）', () => {
  // 原版 #1：0→100 用 10（base=10t）。t=2 覆盖到 100 立即生效并保持到 t=4，
  // t=4（实际 100）发起归还，时长 6：actual = 100 + (t-4)/6*(10t-100)
  //   = (10/6)t^2 - (50/3)t + 500/3
  // 灯 1000W，容量 800（即 actual > 80）。
  // t=4 actual=100 超载；t=10 actual=100 超载。actual 在窗内先降后升？
  // actual(4)=100；求 actual=80 的交点：(t-4)(10t-100) = -120
  //   10t^2-140t+400=-120 → 10t^2-140t+520=0 → t^2-14t+52=0
  //   t = (14 ± sqrt(196-208)... disc<0)？重算：
  //   actual=100+(t-4)(10t-100)/6 = 100 + (10t^2-140t+400)/6
  //   6*actual = 600 + 10t^2 - 140t + 400 = 10t^2-140t+1000
  //   actual=80 → 10t^2-140t+1000=480 → 10t^2-140t+520=0 → disc=19600-2080=-1200 <0
  // 即归还全程 actual > 80，整段超载。
  const cues = [{ cue_no: 1, light_id: 1, time: 0, target: 100, duration: 10 }];
  const ops = [
    { seq: 1, light_id: 1, time: 2, op_type: 'override', target: 100, duration: 0 },
    { seq: 2, light_id: 1, time: 4, op_type: 'return', duration: 6 },
  ];
  const iv = overload({ cues, ops, members: [[1, 1000]], capacity: 800, start: 0, end: 12 });
  // 超载自 t=2 覆盖瞬变（闭）起，持续到归还结束 t=10；之后跟随原版（t≥10 恒 100）仍超载
  assert.deepEqual(iv, [IV(2, 12, true, true)]);
});

test('归还融合的二次负载：开口向上，两根之间不超载、两根之外超载', () => {
  // 构造：t=0 覆盖立即到 0；t=2 归还时长 8；原版 0→100 用 20（base=5t）。
  // actual = 0 + (t-2)/8 * 5t = (5/8)t(t-2)，t∈[2,10]；t>10 跟随原版 5t。
  // 1000W 灯，容量 200（actual>20）。
  // 5/8 t(t-2) > 20 → t^2-2t-32>0 → t > 1+sqrt(33) ≈ 6.7446
  const cues = [{ cue_no: 1, light_id: 1, time: 0, target: 100, duration: 20 }];
  const ops = [
    { seq: 1, light_id: 1, time: 0, op_type: 'override', target: 0, duration: 0 },
    { seq: 2, light_id: 1, time: 2, op_type: 'return', duration: 8 },
  ];
  const members = [[1, 1000]];
  const root = 1 + Math.sqrt(33);
  const iv = overload({ cues, ops, members, capacity: 200, start: 0, end: 20 });
  // [2, root] 段内 t≤root 不超载（t=2 点 actual=0）；交点开；窗右端闭合
  assert.equal(iv.length, 1);
  assert.ok(Math.abs(iv[0].start - root) < 1e-9);
  assert.equal(iv[0].start_inclusive, false);
  assert.equal(iv[0].end, 20);
  assert.equal(iv[0].end_inclusive, true);
  // 交点数值与逐点求值一致
  assert.ok(Math.abs(loadAt({ cues, ops, members, at: root }) - 200) < 1e-6);
  assert.ok(loadAt({ cues, ops, members, at: 8 }) > 200);
});

test('极短超载脉冲不会被漏判：两瞬变夹住的短窗也精确给出', () => {
  // #1 t=4.99 瞬变到 100，t=5.01 瞬变到 0（1000W），容量 500。
  // 超载区间 [4.99, 5.01)：开灯瞬间含；关灯瞬间（t=5.01）负载已为 0，不含
  const cues = [
    { cue_no: 1, light_id: 1, time: 4.99, target: 100, duration: 0 },
    { cue_no: 2, light_id: 1, time: 5.01, target: 0, duration: 0 },
  ];
  assert.deepEqual(overload({ cues, members: [[1, 1000]], capacity: 500, start: 0, end: 10 }), [
    IV(4.99, 5.01, true, false),
  ]);
  // 时窗右端恰落在关灯瞬间：窗内最后一个开段到 5.01 前为止，右端点不超载
  assert.deepEqual(overload({ cues, members: [[1, 1000]], capacity: 500, start: 0, end: 5.01 }), [
    IV(4.99, 5.01, true, false),
  ]);
});

test('同秒顺序：多条 0 秒 Cue 以最后生效值决定触发点负载', () => {
  // cue_no=1 置 100，cue_no=2 置 0：t=3 最终为 0，不超载
  const cuesOff = [
    { cue_no: 1, light_id: 1, time: 3, target: 100, duration: 0 },
    { cue_no: 2, light_id: 1, time: 3, target: 0, duration: 0 },
  ];
  assert.deepEqual(overload({ cues: cuesOff, members: [[1, 1000]], capacity: 500, start: 0, end: 6 }), []);
  // 反过来：最终 100 → [3,6]
  const cuesOn = [
    { cue_no: 1, light_id: 1, time: 3, target: 0, duration: 0 },
    { cue_no: 2, light_id: 1, time: 3, target: 100, duration: 0 },
  ];
  assert.deepEqual(overload({ cues: cuesOn, members: [[1, 1000]], capacity: 500, start: 0, end: 6 }), [
    IV(3, 6, true, true),
  ]);
});

test('覆盖渐变被中途接管：折线负载精确', () => {
  // 原版恒 0。t=0 覆盖 0→100 用 10（actual=10t），t=5（50）接管覆盖到 0 用 5（100-10(t-5)）。
  const ops = [
    { seq: 1, light_id: 1, time: 0, op_type: 'override', target: 100, duration: 10 },
    { seq: 2, light_id: 1, time: 5, op_type: 'override', target: 0, duration: 5 },
  ];
  assert.deepEqual(overload({ ops, members: [[1, 1000]], capacity: 400, start: 0, end: 10 }), [
    IV(4, 6, false, false),
  ]);
});

test('零长度时窗返回 []，无成员的回路恒不超载', () => {
  const cues = [{ cue_no: 1, light_id: 1, time: 0, target: 100, duration: 0 }];
  assert.deepEqual(overload({ cues, members: [[1, 1000]], capacity: 1, start: 5, end: 5 }), []);
  assert.deepEqual(overload({ cues, members: [], capacity: 1, start: 0, end: 10 }), []);
});
