/*
 * 灯光 Cue 渐变引擎（纯函数，无依赖）
 * 浏览器与 Node 共用：浏览器挂到 window.LightingEngine，Node 通过 module.exports 引入。
 *
 * 规则：
 *  - 每条 Cue 在 time 秒触发，把指定灯具从触发瞬间的“实际亮度”线性渐变到 target，
 *    渐变耗时 duration 秒（0 表示瞬变）。
 *  - 新 Cue 到来时，若该灯仍在上一条 Cue 的渐变中，以上一渐变在该时刻的实际亮度
 *    为起点转向新目标（中途接管，不跳变）。
 *  - 同一秒触发的多条 Cue，按 Cue 编号（cue_no）从小到大依次生效：
 *      · 前一条是普通渐变时，它在同一瞬间尚未来得及渐变，起点取其起始亮度；
 *      · 前一条是 0 秒瞬变时，它先一步跳到目标，起点取其目标亮度。
 *  - 亮度始终限制在 0～100。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LightingEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN = 0;
  const MAX = 100;

  function clamp(v) {
    if (v < MIN) return MIN;
    if (v > MAX) return MAX;
    return v;
  }

  /**
   * 整理一场演出的 Cue：按触发时码、再按 Cue 编号（同秒先后次序）排序，
   * 并为每盏灯把 Cue 展开成“渐变段”，预先记录每条 Cue 触发瞬间的实际起始亮度。
   * cue 字段：{ cue_no, light_id, time, target, duration }
   */
  function prepareCues(cues) {
    const ordered = cues
      .map((c) => ({
        cueNo: c.cue_no,
        lightId: c.light_id,
        time: Number(c.time),
        target: clamp(Number(c.target)),
        duration: Number(c.duration),
        end: Number(c.time) + Number(c.duration),
        from: 0, // 触发瞬间的实际亮度，下面按灯逐条计算
      }))
      .sort((a, b) => a.time - b.time || a.cueNo - b.cueNo);

    // 每盏灯只与自己的上一条 Cue 衔接
    const last = new Map();
    for (const seg of ordered) {
      const prev = last.get(seg.lightId);
      if (!prev) {
        seg.from = 0; // 该灯的第一条 Cue：从熄灭状态起步
      } else if (seg.time > prev.time) {
        if (seg.time >= prev.end || prev.duration === 0) {
          seg.from = prev.target; // 上一渐变已结束（或为瞬变）：保持在目标
        } else {
          // 中途接管：取上一渐变在新 Cue 触发时刻的实际亮度
          const k = (seg.time - prev.time) / prev.duration;
          seg.from = clamp(prev.from + (prev.target - prev.from) * k);
        }
      } else {
        // 同一时刻触发（已按编号排好序）：
        // 瞬变 Cue 先一步跳到目标；普通渐变此刻还未产生变化，取其起始亮度
        seg.from = prev.duration === 0 ? prev.target : prev.from;
      }
      last.set(seg.lightId, seg);
    }
    return ordered;
  }

  /**
   * 计算 t 秒时某盏灯的实际亮度：
   * 只需找到该灯“触发时刻 <= t”的最后一条 Cue（即当前生效段）。
   */
  function brightnessAt(orderedCues, lightId, t) {
    let active = null;
    for (const seg of orderedCues) {
      if (seg.lightId !== lightId) continue;
      if (seg.time > t) break; // 全局已按 time, cueNo 排序
      active = seg;
    }
    if (!active) return 0;
    if (active.duration === 0 || t >= active.end) return active.target;
    const k = (t - active.time) / active.duration;
    return clamp(active.from + (active.target - active.from) * k);
  }

  /** 整场演出所有灯具在 t 秒的亮度表 { lightId: brightness } */
  function levelsAt(orderedCues, lights, t) {
    const out = {};
    for (const l of lights) {
      out[l.id] = brightnessAt(orderedCues, l.id, t);
    }
    return out;
  }

  /** 演出总时长 = 最后一条 Cue 渐变结束时刻（无 Cue 时为 0） */
  function showDuration(orderedCues) {
    let d = 0;
    for (const c of orderedCues) {
      if (c.end > d) d = c.end;
    }
    return d;
  }

  /* --------------------- 两版亮度差区间（精确解析解） --------------------- */

  // 浮点容差：用于“本应相等”的端点归类（阈值交点、重复转折点），
  // 输出也按 1e-9 四舍五入，避免二进制末位噪声。
  const EPS = 1e-9;

  function norm9(x) {
    const r = Math.round(x * 1e9) / 1e9;
    return r === 0 ? 0 : r;
  }

  /** 收集一版中某盏灯落在 [start, end] 内的全部转折点（Cue 触发时刻 + 渐变结束时刻） */
  function collectBreakpoints(orderedCues, lightId, start, end, out) {
    for (const seg of orderedCues) {
      if (seg.lightId !== lightId) continue;
      if (seg.time >= start && seg.time <= end) out.push(seg.time);
      if (seg.end >= start && seg.end <= end) out.push(seg.end);
    }
  }

  /**
   * 取 t 所在开区间上该灯亮度的线性表达式 b(t) = a*t + b0。
   * 调用方保证 t 不落在任何转折点上：此时生效段唯一，亮度必为线性（含常量）。
   */
  function lineAt(orderedCues, lightId, t) {
    let active = null;
    for (const seg of orderedCues) {
      if (seg.lightId !== lightId) continue;
      if (seg.time > t) break; // 全局已按 time, cueNo 排序
      active = seg;
    }
    if (!active) return { a: 0, b: 0 };
    if (active.duration === 0 || t >= active.end) return { a: 0, b: active.target };
    const a = (active.target - active.from) / active.duration;
    return { a, b: active.from - a * active.time };
  }

  function snapEdge(x, u, v) {
    if (Math.abs(x - u) <= EPS) return u;
    if (Math.abs(x - v) <= EPS) return v;
    return x;
  }

  /**
   * 开区间 (u,v) 内 L(t)=a*t+b0 为线性，求 |L| > threshold 的部分，
   * 以两端开区间形式加入 pieces（端点是否属于集合由转折点上的单点决定）。
   */
  function pushLinearPieces(pieces, a, b0, u, v, threshold) {
    const open = (lo, hi) => {
      if (hi - lo > EPS) pieces.push({ lo, hi, loInc: false, hiInc: false });
    };
    if (Math.abs(a) <= EPS) {
      if (Math.abs(b0) - threshold > EPS) open(u, v);
      return;
    }
    const rHi = snapEdge((threshold - b0) / a, u, v);  // L = +threshold
    const rLo = snapEdge((-threshold - b0) / a, u, v); // L = -threshold
    if (a > 0) {
      if (rHi < v) open(Math.max(u, rHi), v); // L > threshold：t > rHi
      if (rLo > u) open(u, Math.min(v, rLo)); // L < -threshold：t < rLo
    } else {
      if (rHi > u) open(u, Math.min(v, rHi)); // L > threshold：t < rHi
      if (rLo < v) open(Math.max(u, rLo), v); // L < -threshold：t > rLo
    }
  }

  /**
   * 合并一维区间（含端点包含性）。相邻 [..,x] 与 [x,..] 只要任一侧包含 x 即连通，
   * 因此夹在中间的闭单点（瞬变造成的孤立超差时刻）能把两侧区间桥接起来。
   */
  function unionPieces(input) {
    const ps = input
      .map((p) => ({ ...p }))
      .sort((x, y) => x.lo - y.lo || Number(y.loInc) - Number(x.loInc));
    const out = [];
    for (const p of ps) {
      let cur = p;
      while (out.length) {
        const q = out[out.length - 1];
        const atJoint = Math.abs(cur.lo - q.hi) <= EPS;
        const overlap = cur.lo < q.hi && !atJoint;
        if (!overlap && !(atJoint && (q.hiInc || cur.loInc))) break;
        out.pop();
        let lo, loInc, hi, hiInc;
        if (q.lo < cur.lo) { lo = q.lo; loInc = q.loInc; }
        else if (cur.lo < q.lo) { lo = cur.lo; loInc = cur.loInc; }
        else { lo = q.lo; loInc = q.loInc || cur.loInc; }
        if (q.hi > cur.hi) { hi = q.hi; hiInc = q.hiInc; }
        else if (cur.hi > q.hi) { hi = cur.hi; hiInc = cur.hiInc; }
        else { hi = q.hi; hiInc = q.hiInc || cur.hiInc; }
        cur = { lo, hi, loInc, hiInc };
      }
      out.push(cur);
    }
    return out
      .filter((p) => p.hi - p.lo > EPS || (p.loInc && p.hiInc))
      .map((p) => ({
        start: norm9(p.lo),
        end: norm9(p.hi),
        start_inclusive: p.loInc,
        end_inclusive: p.hiInc,
      }));
  }

  /**
   * 计算时窗 [start, end] 内，某盏灯在两版间亮度差严格大于 threshold 的全部连续区间。
   *
   * 精确做法（不做固定间隔采样）：
   *  1. 转折点 = 两版该灯全部 Cue 触发时刻与渐变结束时刻（再加时窗端点）。
   *     瞬变只在触发点造成跳变，其余位置两版亮度均连续（中途接管不跳变）。
   *  2. 相邻转折点之间，两版亮度各为一条直线，差值 |L(t)| 为线性函数取绝对值，
   *     与 ±threshold 的交点用一次方程精确求出，严格大于故交点本身为开端点。
   *  3. 每个转折点处按引擎语义（同秒编号顺序、瞬变、接管）取真实亮度，
   *     超差则作为闭单点参与合并，从而准确界定跳变时刻的端点包含性
   *     （含“仅某一瞬间超差”的零长度区间 [t,t]）。
   *
   * cuesA/cuesB 均为 prepareCues 的结果；start === end（零长度时窗）返回 []。
   */
  function differenceIntervals(cuesA, cuesB, lightId, start, end, threshold) {
    if (!(end > start)) return [];

    const bp = [start, end];
    collectBreakpoints(cuesA, lightId, start, end, bp);
    collectBreakpoints(cuesB, lightId, start, end, bp);
    bp.sort((x, y) => x - y);
    const points = [];
    for (const t of bp) {
      if (!points.length || points[points.length - 1] !== t) points.push(t);
    }

    const pieces = [];

    // 转折点上的真实取值（瞬变跳变只可能发生在这里）
    for (const p of points) {
      const d = Math.abs(brightnessAt(cuesA, lightId, p) - brightnessAt(cuesB, lightId, p));
      if (d - threshold > EPS) {
        pieces.push({ lo: p, hi: p, loInc: true, hiInc: true });
      }
    }

    // 相邻转折点之间：差值为 |线性函数|，精确解交点
    for (let i = 0; i + 1 < points.length; i++) {
      const u = points[i];
      const v = points[i + 1];
      if (!(v - u > EPS)) continue; // 近重复点造成的退化段
      const m = (u + v) / 2;
      const la = lineAt(cuesA, lightId, m);
      const lb = lineAt(cuesB, lightId, m);
      pushLinearPieces(pieces, la.a - lb.a, la.b - lb.b, u, v, threshold);
    }

  return unionPieces(pieces);
  }

  /* --------------------- 临时调光（覆盖 / 归还）记录 --------------------- */

  /**
   * 段 seg 在时刻 t 的输出。仅依赖 seg.from（准备阶段已按前一段算好）与原版亮度，
   * 无需继续向前追溯：中途接管时 seg.from 就是接管起点。
   */
  function segOutput(seg, t, baseCues) {
    const base = (tt) => brightnessAt(baseCues, seg.lightId, tt);
    if (seg.duration === 0) {
      // 0 秒操作立即生效：覆盖跳到目标；归还是一条立即完成的融合，此后完全跟随原版
      return seg.opType === 'override' ? seg.target : base(t);
    }
    if (t <= seg.time) return seg.from;
    if (t >= seg.end) {
      // 覆盖到达目标后保持；归还结束后完全跟随原版
      return seg.opType === 'override' ? seg.target : base(t);
    }
    const k = (t - seg.time) / seg.duration;
    if (seg.opType === 'override') {
      return clamp(seg.from + (seg.target - seg.from) * k);
    }
    // 归还：按进度与该时刻持续变化的原版亮度线性融合
    return clamp(seg.from + (base(t) - seg.from) * k);
  }

  /**
   * 展开一份临时调光记录的操作序列。
   *
   * 操作字段：{ seq, light_id, time, op_type: 'override'|'return', target?, duration }
   * 原版 Cue 仍按既有规则在后台运行（baseCues 为 prepareCues 的结果）。
   *
   * 规则：
   *  - 覆盖(override)：从操作瞬间的【实际输出】线性渐变到 target（0～100），此后保持，
   *    直到被后续操作接管；duration 为 0 立即生效。
   *  - 归还(return)：以操作瞬间的【实际输出】为起点，在 duration 内按进度
   *    与该时刻【持续变化的原版亮度】线性融合（凸组合），结束后完全跟随原版。
   *  - 下一操作可在渐变未完成时接管，起点一律取该时刻实际输出（不跳变、不重置）；
   *    同一时刻（同秒）的多条操作按 seq 追加顺序逐条生效（与 Cue 同秒编号顺序同理）。
   *
   * 返回按灯具分组的段数组（保持全局 time, seq 顺序），每段预存起始亮度 from。
   */
  function prepareOverrides(ops, baseCues) {
    const ordered = ops
      .map((o) => ({
        seq: Number(o.seq),
        lightId: Number(o.light_id),
        time: Number(o.time),
        opType: o.op_type,
        target: o.op_type === 'override' ? clamp(Number(o.target)) : null,
        duration: Number(o.duration),
        end: Number(o.time) + Number(o.duration),
        from: 0, // 操作瞬间的实际输出，下面逐条计算
      }))
      .sort((a, b) => a.time - b.time || a.seq - b.seq);

    const last = new Map(); // 每盏灯的上一段（已按 time, seq 排好序）
    for (const seg of ordered) {
      const prev = last.get(seg.lightId);
      if (!prev) {
        seg.from = brightnessAt(baseCues, seg.lightId, seg.time);
      } else {
        // 含中途接管（此刻上一段仍在渐变中）与同秒顺序（0 秒操作已生效、普通渐变 k=0）
        seg.from = segOutput(prev, seg.time, baseCues);
      }
      last.set(seg.lightId, seg);
    }

    const byLight = new Map();
    for (const seg of ordered) {
      if (!byLight.has(seg.lightId)) byLight.set(seg.lightId, []);
      byLight.get(seg.lightId).push(seg);
    }
    return byLight;
  }

  /** 某盏灯在临时调光记录下 t 时刻的实际输出 */
  function overrideBrightnessAt(byLight, baseCues, lightId, t) {
    const segs = byLight.get(lightId);
    if (!segs) return brightnessAt(baseCues, lightId, t);
    let active = null;
    for (const seg of segs) {
      if (seg.time > t) break; // 已按 time, seq 排序
      active = seg;
    }
    if (!active) return brightnessAt(baseCues, lightId, t);
    return segOutput(active, t, baseCues);
  }

  /**
   * 某盏灯在 t 时刻是否处于临时接管状态，供界面标注：
   * 'override'（覆盖保持/渐变中）| 'return'（归还融合中）| null（完全跟随原版）。
   * 0 秒归还立即完成，除操作瞬间外均跟随原版，状态按 null 处理。
   */
  function activeOverride(byLight, lightId, t) {
    const segs = byLight.get(lightId);
    if (!segs) return null;
    let active = null;
    for (const seg of segs) {
      if (seg.time > t) break;
      active = seg;
    }
    if (!active) return null;
    if (active.opType === 'override') return { seg: active, state: 'override' };
    if (active.duration > 0 && t < active.end) return { seg: active, state: 'return' };
    return null;
  }

  /** 记录下整场（快照灯具）在 t 时刻的逐灯实际输出表 */
  function overrideLevelsAt(byLight, baseCues, lights, t) {
    const out = {};
    for (const l of lights) {
      out[l.id] = overrideBrightnessAt(byLight, baseCues, l.id, t);
    }
    return out;
  }

  /* --------------------- 回路负载与超载区间（精确解析解） --------------------- */

  /**
   * 某盏灯在临时调光记录下、t 所在开区间上实际输出的表达式：
   * actual(t) = q*t^2 + a*t + b
   * （调用方保证 t 不落在任何转折点上：此时生效段唯一，归还融合的原版亮度亦为线性）
   *
   *  - 覆盖渐变 / 保持：q=0，直线或常量；
   *  - 归还融合中：actual = (1-k)*from + k*base(t)，base 在开区间内为线性，
   *    故 actual 为二次函数（同秒 0 秒操作等特殊情形已由 prepareOverrides 预存 from 处理）；
   *  - 无接管或已完全跟随原版：退化为原版亮度的一次表达式。
   */
  function actualExprAt(byLight, baseCues, lightId, t) {
    const segs = byLight.get(lightId);
    let active = null;
    if (segs) {
      for (const seg of segs) {
        if (seg.time > t) break; // 已按 time, seq 排序
        active = seg;
      }
    }
    if (!active) {
      // 无接管：取原版亮度表达式（0 秒瞬变已结束段在 lineAt 中按常量处理，与 brightnessAt 同语义）
      const line = lineAt(baseCues, lightId, t);
      return { a: line.a, b: line.b, q: 0 };
    }

    if (active.duration === 0) {
      // 0 秒操作：覆盖恒为目标；归还立即完成、完全跟随原版
      return active.opType === 'override'
        ? { a: 0, b: active.target, q: 0 }
        : lineAt(baseCues, lightId, t);
    }
    if (t < active.time || t >= active.end) {
      // 区间内 t 应落在 (seg.time, seg.end)；取到端点是近重复转折点的退化情形，按常量处理
      return { a: 0, b: segOutput(active, t, baseCues), q: 0 };
    }

    if (active.opType === 'override') {
      const a = (active.target - active.from) / active.duration;
      return { a, b: active.from - a * active.time, q: 0 };
    }

    // 归还融合：actual = (1-k)*from + k*base(t)
    // 设 d=duration, T=seg.time, base(t)=m*t+c, k=(t-T)/d
    // actual = from + (t-T)/d * (m*t + c - from)
    //        = (m/d) t^2 + ((c-from-m*T)/d) t + from - T(c-from)/d
    const m0 = lineAt(baseCues, lightId, t);
    const { a: m, b: c } = m0;
    const d = active.duration;
    const T = active.time;
    const from = active.from;
    const q = m / d;
    const a = (c - from - m * T) / d;
    const b = from - (T * (c - from)) / d;
    return { a, b, q };
  }

  /** 收集一盏灯（在原版 Cue 与临时操作叠加下）影响实际输出形态的全部转折点 */
  function collectActualBreakpoints(baseCues, segs, start, end, out) {
    for (const seg of baseCues) {
      // 触发时刻对普通渐变与 0 秒瞬变都是转折点；渐变结束时刻仅 duration>0 时与触发点不同
      if (seg.time >= start && seg.time <= end) out.push(seg.time);
      if (seg.duration > 0 && seg.end >= start && seg.end <= end) out.push(seg.end);
    }
    if (!segs) return;
    for (const s of segs) {
      if (s.time >= start && s.time <= end) out.push(s.time);
      if (s.duration > 0 && s.end >= start && s.end <= end) out.push(s.end);
    }
  }

  /**
   * 开区间 (u,v) 内 f(t)=a*t+b0 为线性，求 f(t) > 0 的部分，端点严格不含。
   * 用于「无临时操作」或实际输出为一次式的回路。
   */
  function pushLinearPositive(pieces, a, b0, u, v) {
    if (Math.abs(a) <= EPS) {
      if (b0 > EPS) pieces.push({ lo: u, hi: v, loInc: false, hiInc: false });
      return;
    }
    const r = snapEdge(-b0 / a, u, v); // f = 0 的交点
    if (a > 0) {
      if (r < v) pieces.push({ lo: Math.max(u, r), hi: v, loInc: false, hiInc: false });
    } else if (r > u) {
      pieces.push({ lo: u, hi: Math.min(v, r), loInc: false, hiInc: false });
    }
  }

  /**
   * 开区间 (u,v) 内 f(t)=q*t^2+a*t+b0 为二次函数，求 f(t) > 0 的部分（端点严格不含）。
   * 用求根公式精确给出交点，杜绝固定步长采样漏掉短时超载。
   */
  function pushQuadraticPositive(pieces, q, a, b0, u, v) {
    const open = (lo, hi) => {
      if (hi - lo > EPS) pieces.push({ lo, hi, loInc: false, hiInc: false });
    };
    if (Math.abs(q) <= EPS) return pushLinearPositive(pieces, a, b0, u, v);

    const disc = a * a - 4 * q * b0;
    if (disc < -EPS) {
      // 无实根：整段同号
      if (q > 0) open(u, v);
      return;
    }
    if (disc <= EPS) {
      // 重根：f 恒不小于/大于 0，严格大于只在重根以外（重根本身等于 0）
      const rt = snapEdge(-a / (2 * q), u, v);
      if (q > 0) {
        open(u, Math.min(v, rt));
        open(Math.max(u, rt), v);
      }
      return;
    }
    const sq = Math.sqrt(disc);
    let r1 = (-a - sq) / (2 * q);
    let r2 = (-a + sq) / (2 * q);
    if (r1 > r2) [r1, r2] = [r2, r1];
    r1 = snapEdge(r1, u, v);
    r2 = snapEdge(r2, u, v);

    if (q > 0) {
      // 开口向上：两根之外为正
      open(u, Math.min(v, r1));
      open(Math.max(u, r2), v);
    } else {
      // 开口向下：两根之间为正
      open(Math.max(u, r1), Math.min(v, r2));
    }
  }

  /**
   * 计算时窗 [start, end] 内，某条回路负载严格大于其容量的全部连续区间。
   *
   * 精确做法（不做固定间隔采样）：
   *  1. 转折点 = 窗内该回路各灯的 Cue 触发时刻、渐变结束时刻，以及临时调光操作的
   *     触发/结束时刻。瞬变（0 秒 Cue、0 秒覆盖）只在触发点造成跳变，其余位置连续。
   *  2. 相邻转折点之间：
   *       · 无临时调光时各灯亮度为一次式，负载为一次函数；
   *       · 绑定临时调光记录时，归还融合中的实际输出 = 进度 × 持续变化的原版亮度，
   *         为二次函数；覆盖为一次式。回路负载为各灯贡献之和（二次/一次）。
   *     与 0（容量差）的交点用一次/二次方程精确求出，严格超出故交点为开端点。
   *  3. 每个转折点按引擎语义（同秒编号顺序、瞬变、中途接管、覆盖/归还融合）取真实负载，
   *     超载则作为闭单点参与合并，准确界定跳变时刻的端点包含性（含「仅某一瞬间超载」
   *     的零长度区间 [t,t]）。
   *
   * members: [{ light_id, rated_watts }]（仅含已分配到该回路、额定瓦数为正的灯具）
   * capacity: 该回路冻结容量（正数）
   * 返回与 differenceIntervals 相同的区间对象数组；start === end 返回 []。
   */
  function overloadIntervals(baseCues, byLight, members, capacity, start, end) {
    if (!(end > start)) return [];

    const bp = [start, end];
    for (const m of members) {
      collectActualBreakpoints(baseCues, byLight.get(m.light_id), start, end, bp);
    }
    bp.sort((x, y) => x - y);
    // 近重复转折点合并（来自不同灯、在浮点误差内重合的时刻），避免退化段漏判
    const points = [];
    for (const t of bp) {
      if (!points.length || Math.abs(points[points.length - 1] - t) > EPS) points.push(t);
    }

    const loadAt = (t) => {
      let sum = 0;
      for (const m of members) {
        sum += (overrideBrightnessAt(byLight, baseCues, m.light_id, t) / 100) * m.rated_watts;
      }
      return sum;
    };

    const pieces = [];

    // 转折点上的真实负载（瞬变跳变只可能发生在这里；严格超出 → 闭单点）
    for (const p of points) {
      if (loadAt(p) - capacity > EPS) {
        pieces.push({ lo: p, hi: p, loInc: true, hiInc: true });
      }
    }

    // 相邻转折点之间：负载为二次（归还融合）或一次函数，精确求超载部分
    for (let i = 0; i + 1 < points.length; i++) {
      const u = points[i];
      const v = points[i + 1];
      if (!(v - u > EPS)) continue;
      const mid = (u + v) / 2;
      let q = 0;
      let a = 0;
      let b = -capacity;
      let quadratic = false;
      for (const m of members) {
        const e = actualExprAt(byLight, baseCues, m.light_id, mid);
        const w = m.rated_watts / 100;
        q += (e.q || 0) * w;
        a += e.a * w;
        b += e.b * w;
        if (Math.abs(e.q || 0) > EPS) quadratic = true;
      }
      if (quadratic) pushQuadraticPositive(pieces, q, a, b, u, v);
      else pushLinearPositive(pieces, a, b, u, v);
    }

    return unionPieces(pieces);
  }

  return {
    clamp,
    prepareCues,
    brightnessAt,
    levelsAt,
    showDuration,
    differenceIntervals,
    prepareOverrides,
    overrideBrightnessAt,
    overrideLevelsAt,
    activeOverride,
    overloadIntervals,
    actualExprAt,
  };
});
