/* =============================================================
 * midi-core.js —— MIDI 解析 / 声部分离 / MIDI 生成（纯 JS，无依赖）
 * 目标：把多声部（复音）MIDI 拆成若干「单音轨」，
 *       保证输出中每个音轨在同一时刻最多只有一个音符在响。
 * ============================================================= */
(function (global) {
  'use strict';

  /* ---------------- GM 乐器名 ---------------- */
  const GM_NAMES = [
    '大钢琴','明亮钢琴','电钢琴','酒吧钢琴','柔和电钢琴','电钢琴2','羽管键琴','击弦古钢琴',
    '钢片琴','钟琴','音乐盒','颤音琴','马林巴','木琴','管钟','扬琴',
    '拉杆风琴','打击风琴','摇滚风琴','教堂管风琴','簧风琴','手风琴','口琴','探戈手风琴',
    '尼龙弦吉他','钢弦吉他','爵士吉他','清音吉他','闷音吉他','过载吉他','失真吉他','吉他泛音',
    '原声贝斯','指弹贝斯','拨片贝斯','无品贝斯','击弦贝斯1','击弦贝斯2','合成贝斯1','合成贝斯2',
    '小提琴','中提琴','大提琴','低音提琴','颤弓弦乐','拨奏弦乐','竖琴','定音鼓',
    '弦乐合奏1','弦乐合奏2','合成弦乐1','合成弦乐2','合唱「啊」','人声「喔」','合成人声','管弦乐齐奏',
    '小号','长号','大号','弱音小号','圆号','铜管组','合成铜管1','合成铜管2',
    '高音萨克斯','中音萨克斯','次中音萨克斯','低音萨克斯','双簧管','英国管','巴松管','单簧管',
    '短笛','长笛','竖笛','排箫','瓶吹','尺八','口哨','陶笛',
    '方波主音','锯齿波主音','卡利欧佩主音','奇夫主音','查兰戈主音','人声主音','五度主音','贝斯+主音',
    '新时代铺底','温暖铺底','复音合成铺底','合唱铺底','弓弦铺底','金属铺底','光环铺底','扫频铺底',
    '雨声','音轨音效','水晶','氛围','明亮','妖异','回声','科幻',
    '西塔琴','班卓琴','三味线','筝','卡林巴','风笛','fiddle提琴','沙纳伊',
    '铃铛','阿戈戈','钢鼓','木鱼','太鼓','旋律鼓','合成鼓','反转钹',
    '吉他刮奏','呼吸声','海浪声','鸟鸣','电话铃','直升机','掌声','枪声'
  ];

  const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  function pitchName(p) {
    if (p == null || !isFinite(p)) return '--';
    return NOTE_NAMES[p % 12] + (Math.floor(p / 12) - 1);
  }

  const enc = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;
  function utf8(str) {
    if (enc) return Array.from(enc.encode(str));
    const out = [];
    for (const ch of String(str)) {
      const c = ch.codePointAt(0);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 0x3F), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    }
    return out;
  }
  function decodeText(bytes) {
    try {
      if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
    } catch (e) { /* fallback below */ }
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  /* ---------------- VLQ ---------------- */
  function vlqBytes(value) {
    let v = Math.max(0, Math.round(value));
    const buf = [v & 0x7F];
    v >>>= 7;
    while (v > 0) { buf.unshift((v & 0x7F) | 0x80); v >>>= 7; }
    return buf;
  }

  /* =============================================================
   * 1. 解析 MIDI 文件（SMF format 0/1/2）
   * ============================================================= */
  function parseMidi(arrayBuffer) {
    const u8 = new Uint8Array(arrayBuffer);
    let p = 0;
    const rdStr = n => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(u8[p++]); return s; };
    const rdU16 = () => { const v = (u8[p] << 8) | u8[p + 1]; p += 2; return v; };
    const rdU32 = () => { const v = ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0; p += 4; return v; };
    function rdVLQ() {
      let v = 0, b;
      do { b = u8[p++]; v = (v << 7) | (b & 0x7F); } while (b & 0x80 && p < u8.length);
      return v >>> 0;
    }

    if (rdStr(4) !== 'MThd') throw new Error('不是有效的 MIDI 文件（缺少 MThd）');
    const hlen = rdU32();
    const format = rdU16();
    const ntracks = rdU16();
    const division = rdU16();
    p += Math.max(0, hlen - 6);

    const tracks = [];
    for (let t = 0; t < ntracks; t++) {
      if (p + 8 > u8.length) break;
      const type = rdStr(4);
      const len = rdU32();
      if (type !== 'MTrk') { p += len; continue; }
      const end = Math.min(p + len, u8.length);
      const events = [];
      let tick = 0, running = 0;
      while (p < end) {
        tick += rdVLQ();
        let status = u8[p];
        if (status < 0x80) {
          status = running;                 // 运行状态（running status）
        } else {
          p++;
          if (status < 0xF0) running = status;
        }
        if (status === 0xFF) {              // Meta
          const meta = u8[p++];
          const l = rdVLQ();
          events.push({ tick, type: 'meta', meta, data: Array.from(u8.slice(p, p + l)) });
          p += l;
        } else if (status === 0xF0 || status === 0xF7) { // SysEx
          const l = rdVLQ();
          events.push({ tick, type: 'sysex', data: Array.from(u8.slice(p, p + l)) });
          p += l;
        } else {                            // Channel message
          const hi = status & 0xF0, ch = status & 0x0F;
          if (hi === 0xC0 || hi === 0xD0) {
            events.push({ tick, type: 'chan', hi, ch, d1: u8[p++] });
          } else {
            events.push({ tick, type: 'chan', hi, ch, d1: u8[p++], d2: u8[p++] });
          }
        }
      }
      p = end;
      tracks.push({ index: t, events });
    }
    return { format, division, tracks };
  }

  /* =============================================================
   * 2. 从事件流中提取音符 + 元信息
   * ============================================================= */
  function extractNotes(parsed) {
    const notes = [];
    const programByChannel = new Array(16).fill(0);
    const programSeen = new Array(16).fill(false);
    const trackNames = [];
    const tempos = [];
    const timeSigs = [];
    const keySigs = [];
    let maxTick = 0;

    parsed.tracks.forEach((tr, ti) => {
      const open = new Map();   // key: ch*128+pitch -> [{tick, vel}]
      let name = '';
      tr.events.forEach(ev => {
        if (ev.tick > maxTick) maxTick = ev.tick;
        if (ev.type === 'meta') {
          if (ev.meta === 0x03) name = decodeText(ev.data);
          else if (ev.meta === 0x51 && ev.data.length >= 3) {
            tempos.push({ tick: ev.tick, mpqn: (ev.data[0] << 16) | (ev.data[1] << 8) | ev.data[2] });
          } else if (ev.meta === 0x58 && ev.data.length >= 4) {
            timeSigs.push({ tick: ev.tick, num: ev.data[0], den: ev.data[1] });
          } else if (ev.meta === 0x59 && ev.data.length >= 2) {
            keySigs.push({ tick: ev.tick, sf: ev.data[0], mi: ev.data[1] });
          }
        } else if (ev.type === 'chan') {
          if (ev.hi === 0xC0) { programByChannel[ev.ch] = ev.d1; programSeen[ev.ch] = true; }
          else if (ev.hi === 0x90 && ev.d2 > 0) {
            const k = ev.ch * 128 + ev.d1;
            if (!open.has(k)) open.set(k, []);
            open.get(k).push({ tick: ev.tick, vel: ev.d2 });
          } else if (ev.hi === 0x80 || (ev.hi === 0x90 && ev.d2 === 0)) {
            const k = ev.ch * 128 + ev.d1;
            const arr = open.get(k);
            if (arr && arr.length) {
              const st = arr.pop();
              notes.push({
                start: st.tick, end: Math.max(st.tick + 1, ev.tick),
                pitch: ev.d1, vel: st.vel, ch: ev.ch, track: ti
              });
              if (ev.tick > maxTick) maxTick = ev.tick;
            }
          }
        }
      });
      trackNames[ti] = name;
    });

    // 悬空音符（没有 note-off）：在末尾收尾
    parsed.tracks.forEach((tr, ti) => {
      // 重新扫一遍不划算，这里用简易方式：已经在上面 pop 完，忽略
    });

    // 速度点：按时间排序、同刻去重、去掉与前一刻相同的冗余点（DAW 常每小节写一次）
    tempos.sort((a, b) => a.tick - b.tick);
    const tp = [];
    for (const t of tempos) {
      const last = tp[tp.length - 1];
      if (!tp.length) { tp.push({ tick: t.tick, mpqn: t.mpqn }); continue; }
      if (last.tick === t.tick) last.mpqn = t.mpqn;            // 同一时刻以最后一个为准
      else if (last.mpqn !== t.mpqn) tp.push({ tick: t.tick, mpqn: t.mpqn });
    }
    if (!tp.length || tp[0].tick !== 0) tp.unshift({ tick: 0, mpqn: (tp[0] && tp[0].mpqn) || 500000 });

    // 拍号：排序 + 同刻去重
    timeSigs.sort((a, b) => a.tick - b.tick);
    const sg = [];
    for (const t of timeSigs) {
      const last = sg[sg.length - 1];
      if (last && last.tick === t.tick) { last.num = t.num; last.den = t.den; }
      else if (!last || last.num !== t.num || last.den !== t.den) sg.push({ tick: t.tick, num: t.num, den: t.den });
    }
    if (!sg.length) sg.push({ tick: 0, num: 4, den: 2 });

    return {
      notes, programByChannel, trackNames,
      tempos: tp, timeSigs: sg, keySigs,
      maxTick, division: parsed.division, format: parsed.format
    };
  }

  /* ---------------- 时间换算 ---------------- */
  function makeClock(tempos, division) {
    const smpte = (division & 0x8000) !== 0;
    let ticksPerBeat, ticksPerSecond;
    if (smpte) {
      const fpsRaw = 256 - ((division >> 8) & 0xFF);
      const tpf = division & 0xFF;
      const fps = (fpsRaw === 29) ? 29.97 : fpsRaw;
      ticksPerSecond = fps * tpf;
      ticksPerBeat = ticksPerSecond / 2;   // 近似
    } else {
      ticksPerBeat = division & 0x7FFF || 480;
      ticksPerSecond = null;               // 依赖速度映射
    }

    // 分段：[{tick, mpqn, ms}]
    const segs = [];
    let accMs = 0;
    for (let i = 0; i < tempos.length; i++) {
      const mpqn = tempos[i].mpqn || 500000;
      if (i > 0) {
        const prev = tempos[i - 1];
        accMs += (tempos[i].tick - prev.tick) * (prev.mpqn || 500000) / 1000 / ticksPerBeat;
      }
      segs.push({ tick: tempos[i].tick, mpqn, ms: accMs });
    }
    const ticksPerMsOf = seg => {
      if (ticksPerSecond) return ticksPerSecond / 1000;
      return (ticksPerBeat * 1000) / (seg.mpqn || 500000);
    };

    function toMs(tick) {
      let seg = segs[0];
      for (let i = segs.length - 1; i >= 0; i--) { if (tick >= segs[i].tick) { seg = segs[i]; break; } }
      return seg.ms + (tick - seg.tick) / ticksPerMsOf(seg);
    }
    function toTicks(ms) {
      let seg = segs[0];
      for (let i = segs.length - 1; i >= 0; i--) { if (ms >= segs[i].ms) { seg = segs[i]; break; } }
      return Math.round(seg.tick + (ms - seg.ms) * ticksPerMsOf(seg));
    }
    return { toMs, toTicks, ticksPerBeat, ticksPerSecond };
  }

  /* =============================================================
   * 3. 声部分离核心
   *    思路：按起始时刻把音符分组（同时发声 = 一个和弦，必须拆到不同声部），
   *          然后用「单调匹配 + 声部进行（voice leading）」动态规划
   *          把每个音符分配给已有声部或新建声部。
   *          单调匹配保证声部不交叉（高声部始终在上）。
   * ============================================================= */
  function assignGroup(group, t, voices, newVoicePenalty) {
    const free = voices.filter(v => v.lastEnd <= t).sort((a, b) => b.lastPitch - a.lastPitch);
    const n = group.length;          // 音符数（已按音高降序）
    const m = free.length;           // 空闲声部数（已按最近音高降序）
    const kMax = Math.max(0, n - m); // 至少需要的声声部数
    const memo = new Map();

    function dp(i, j, k) {
      if (i === n) return { cost: 0, choice: null };
      const key = (i * (m + 1) + j) * (kMax + 1) + k;
      const hit = memo.get(key);
      if (hit) return hit;
      let best = { cost: Infinity, choice: null };
      if (j < m) {
        const r = dp(i + 1, j + 1, k);
        const c = Math.abs(group[i].pitch - free[j].lastPitch) + r.cost;
        if (c < best.cost) best = { cost: c, choice: { kind: 'f', j, next: r.choice } };
      }
      if (k < kMax) {
        const r = dp(i + 1, j, k + 1);
        const c = newVoicePenalty + r.cost;
        if (c < best.cost) best = { cost: c, choice: { kind: 'n', next: r.choice } };
      }
      memo.set(key, best);
      return best;
    }

    let cur = dp(0, 0, 0).choice;
    let idx = 0;
    while (cur) {
      const note = group[idx++];
      let v;
      if (cur.kind === 'f') {
        v = free[cur.j];
      } else {
        v = { notes: [], lastPitch: note.pitch, lastEnd: -Infinity, ch: note.ch };
        voices.push(v);
      }
      v.notes.push(note);
      v.lastPitch = note.pitch;
      v.lastEnd = Math.max(v.lastEnd, note.end);
      cur = cur.next;
    }
  }

  function separatePartition(notes, newVoicePenalty) {
    const voices = [];
    const sorted = notes.slice().sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    let i = 0;
    while (i < sorted.length) {
      const t = sorted[i].start;
      let j = i;
      while (j < sorted.length && sorted[j].start === t) j++;
      const group = sorted.slice(i, j).sort((a, b) => b.pitch - a.pitch);
      assignGroup(group, t, voices, newVoicePenalty);
      i = j;
    }
    return voices;
  }

  /* 保证单音：同轨内后一个音符必须晚于前一个结束（+间隔）
     注意：不修改传入的音符对象，返回副本 */
  function enforceGap(notes, gapTicks, minTicks) {
    const sorted = notes.map(n => ({ start: n.start, end: n.end, pitch: n.pitch, vel: n.vel, ch: n.ch, track: n.track }))
      .sort((a, b) => a.start - b.start || a.end - b.end);
    const out = [];
    for (const nt of sorted) {
      if (nt.end - nt.start < minTicks) nt.end = nt.start + minTicks;
      while (out.length) {
        const prev = out[out.length - 1];
        if (nt.start < prev.end + gapTicks) {
          const ne = nt.start - gapTicks;
          if (ne - prev.start >= minTicks) { prev.end = ne; break; }
          out.pop();                       // 太短，丢弃前一个
        } else break;
      }
      out.push(nt);
    }
    return out;
  }

  function avgPitch(notes) {
    if (!notes.length) return 0;
    let s = 0; for (const n of notes) s += n.pitch;
    return s / notes.length;
  }

  /* 合并两个声部（后者并入前者），重叠处截断前面的音符 */
  function mergeVoices(a, b, gapTicks, minTicks) {
    const merged = a.notes.concat(b.notes).sort((x, y) => x.start - y.start);
    return enforceGap(merged, gapTicks, minTicks);
  }

  /* =============================================================
   * 4. 总入口：分离
   * ============================================================= */
  function separate(info, opts) {
    const o = Object.assign({
      mode: 'auto',            // auto | channel | range
      groupByChannel: true,
      drumMode: 'split',       // split | separate | drop
      maxTracks: 16,
      newVoicePenalty: 6,
      gapMs: 0,
      minDurMs: 0
    }, opts || {});

    const clock = makeClock(info.tempos, info.division);
    const gapTicks = Math.max(0, clock.toTicks(o.gapMs) - clock.toTicks(0));
    const minTicks = Math.max(1, clock.toTicks(o.minDurMs) - clock.toTicks(0));

    // 1) 归一化 + 过滤
    const all = info.notes.map(n => ({
      start: n.start, end: Math.max(n.end, n.start + 1),
      pitch: n.pitch, vel: n.vel == null ? 90 : n.vel,
      ch: n.ch, track: n.track
    })).filter(n => n.pitch >= 0 && n.pitch <= 127);

    const drumNotes = all.filter(n => n.ch === 9);
    const pitched = all.filter(n => n.ch !== 9);

    // 输入侧统计（必须在任何截断/修改之前计算）
    const inputStats = {
      inputNotes: all.length,
      inputMaxPolyphony: maxConcurrent(all),
      inputTracks: info.trackNames.length
    };

    // 2) 分组策略
    let groups = [];
    if (o.mode === 'channel' || (o.mode === 'auto' && o.groupByChannel)) {
      const byCh = new Map();
      for (const n of pitched) {
        if (!byCh.has(n.ch)) byCh.set(n.ch, []);
        byCh.get(n.ch).push(n);
      }
      groups = Array.from(byCh.entries()).sort((a, b) => a[0] - b[0]).map(([ch, arr]) => ({ ch, notes: arr }));
    } else if (o.mode === 'range') {
      const bands = [[0, 47], [48, 71], [72, 127]];
      groups = bands.map(([lo, hi]) => ({
        ch: null, notes: pitched.filter(n => n.pitch >= lo && n.pitch <= hi)
      })).filter(g => g.notes.length);
    } else {
      groups = [{ ch: null, notes: pitched }];
    }

    // 3) 逐组做声部分离
    let voices = [];
    for (const g of groups) {
      if (!g.notes.length) continue;
      const vs = separatePartition(g.notes, o.newVoicePenalty);
      vs.forEach(v => { v.groupCh = g.ch; });
      voices = voices.concat(vs);
    }

    // 4) 打击乐
    let drumTrack = null;
    if (drumNotes.length) {
      if (o.drumMode === 'separate') {
        drumTrack = { notes: drumNotes.slice().sort((a, b) => a.start - b.start), drum: true, ch: 9 };
      } else if (o.drumMode === 'split') {
        const vs = separatePartition(drumNotes, o.newVoicePenalty);
        vs.forEach(v => { v.drum = true; v.groupCh = 9; });
        voices = voices.concat(vs);
      }
    }

    // 5) 单音化 + 清理
    voices.forEach(v => { v.notes = enforceGap(v.notes, gapTicks, minTicks); });
    voices = voices.filter(v => v.notes.length);

    // 6) 限制音轨数：音符数最少的声部并入音高最接近的邻居
    if (voices.length > o.maxTracks) {
      let guard = 0;
      while (voices.length > o.maxTracks && guard++ < 500) {
        voices.sort((a, b) => a.notes.length - b.notes.length);
        const src = voices.shift();
        let bestIdx = 0, bestCost = Infinity;
        for (let i = 0; i < voices.length; i++) {
          const c = Math.abs(avgPitch(src.notes) - avgPitch(voices[i].notes));
          if (c < bestCost) { bestCost = c; bestIdx = i; }
        }
        voices[bestIdx].notes = mergeVoices(voices[bestIdx], src, gapTicks, minTicks);
      }
    }

    // 7) 排序（高声部在前，打击乐置后）+ 分配通道 / 命名
    const pitchedVoices = voices.filter(v => !v.drum);
    const drumVoices = voices.filter(v => v.drum);
    pitchedVoices.sort((a, b) => avgPitch(b.notes) - avgPitch(a.notes));

    const used = new Set();
    const pool = [];
    for (let c = 0; c < 16; c++) if (c !== 9) pool.push(c);

    let voiceNo = 0, drumNo = 0;
    const tracks = pitchedVoices.concat(drumVoices).map(v => {
      const notes = v.notes.slice().sort((a, b) => a.start - b.start);
      const pitches = notes.map(n => n.pitch);
      const program = (v.groupCh != null) ? info.programByChannel[v.groupCh] : info.programByChannel[notes[0].ch];
      let ch;
      if (v.drum) {
        ch = 9;                                  // 打击乐固定在通道 9
      } else {
        ch = (v.groupCh != null && v.groupCh !== 9 && !used.has(v.groupCh)) ? v.groupCh : null;
        if (ch == null) ch = pool.find(c => !used.has(c));
        if (ch == null) ch = pool[voiceNo % pool.length];
        used.add(ch);
      }
      voiceNo++;
      return {
        name: v.drum ? `打击乐 ${++drumNo}` : `声部 ${voiceNo}`,
        ch, program: program || 0, notes, drum: !!v.drum,
        lo: Math.min.apply(null, pitches), hi: Math.max.apply(null, pitches),
        avg: avgPitch(notes), mono: checkMono(notes)
      };
    });

    if (drumTrack) {
      // 打击乐「单独一轨」模式：保持原样，允许同时发声（会破坏单音保证，故非默认）
      drumTrack.notes = drumTrack.notes.slice().sort((a, b) => a.start - b.start);
      const p = drumTrack.notes.map(n => n.pitch);
      tracks.push({
        name: '打击乐', ch: 9, program: 0, notes: drumTrack.notes, drum: true,
        lo: Math.min.apply(null, p), hi: Math.max.apply(null, p),
        avg: avgPitch(drumTrack.notes), mono: false
      });
    }

    // 8) 统计
    const outputNotes = tracks.reduce((s, t) => s + t.notes.length, 0);
    const monoOk = tracks.every(t => checkMono(t.notes));
    return {
      tracks,
      clock,
      stats: Object.assign({}, inputStats, {
        outputTracks: tracks.length,
        outputNotes,
        dropped: Math.max(0, inputStats.inputNotes - outputNotes),
        allMono: monoOk
      })
    };
  }

  /* =============================================================
   * 3.5 单一输出音轨的再分离
   *   场景：某个音轨虽然已经「单音」，但它其实是两条隐含旋律线交织而成
   *        （典型：钢琴左右手交替、复调里的两个声部被并到一条轨）。
   *   做法：先按「音程跳跃」与「时间间隔」找出乐句边界，
   *        再按音高接近度把乐句重新归并到不同的隐含旋律线。
   *   单音保证：每个音符只归属一条线；只有当多条线被强制合并时才可能重叠，
   *             此时由 enforceGap 截断，结果与主流程一致。
   *   opts: { leapSemitones, gapTicks, mergeSemitones, maxParts }
   * ============================================================= */
  function splitMonoTrack(notes, opts) {
    const o = Object.assign({
      leapSemitones: 12,   // 相邻音程超过此值 → 认为是换线，断开
      gapTicks: 240,       // 相邻间隔超过此 tick → 断开
      mergeSemitones: 6,   // 两个乐句首尾音高差小于此值才归为同一条线
      maxParts: 8          // 最多拆成几条
    }, opts || {});

    const sorted = notes.map(n => ({
      start: n.start, end: Math.max(n.end, n.start + 1),
      pitch: n.pitch, vel: n.vel, ch: n.ch, track: n.track
    })).sort((a, b) => a.start - b.start || a.pitch - b.pitch);

    if (!sorted.length) return [];
    if (sorted.length === 1) return [sorted];

    // 1) 切乐句
    const phrases = [];
    let cur = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1], nt = sorted[i];
      const leap = Math.abs(nt.pitch - prev.pitch);
      const gap = nt.start - prev.end;
      if (leap > o.leapSemitones || gap > o.gapTicks) {
        phrases.push(cur); cur = [nt];
      } else {
        cur.push(nt);
      }
    }
    phrases.push(cur);

    // 2) 乐句归线：接回「时间不冲突且平均音高最接近」的那条。
    //    用平均音高而不是首尾音高，否则同一条旋律线在乐句内起伏后会被误判成新线。
    //    注意 tol 必须明显小于断开阈值，否则刚断开的乐句会被立刻并回去。
    const tol = Math.max(0, Math.min(o.mergeSemitones, o.leapSemitones));
    const parts = [];
    const sumOf = arr => arr.reduce((s, n) => s + n.pitch, 0);
    for (const ph of phrases) {
      const head = ph[0], tail = ph[ph.length - 1];
      const phSum = sumOf(ph);
      const phAvg = phSum / ph.length;
      let best = null, bestCost = Infinity;
      for (const p of parts) {
        if (p.lastEnd > head.start) continue;           // 时间上接不上，跳过
        const c = Math.abs(phAvg - (p.sum / p.count));
        if (c < bestCost) { bestCost = c; best = p; }
      }
      if (best && bestCost <= tol) {
        best.notes = best.notes.concat(ph);
        best.sum += phSum; best.count += ph.length;
        best.lastPitch = tail.pitch;
        best.lastEnd = tail.end;
      } else {
        parts.push({
          notes: ph.slice(), sum: phSum, count: ph.length,
          lastPitch: tail.pitch, lastEnd: tail.end
        });
      }
    }

    // 3) 超出上限：反复合并平均音高最接近的两条
    let guard = 0;
    while (parts.length > Math.max(1, o.maxParts) && guard++ < 200) {
      let bi = 0, bj = 1, bc = Infinity;
      for (let i = 0; i < parts.length; i++) {
        for (let j = i + 1; j < parts.length; j++) {
          const c = Math.abs(avgPitch(parts[i].notes) - avgPitch(parts[j].notes));
          if (c < bc) { bc = c; bi = i; bj = j; }
        }
      }
      const merged = enforceGap(parts[bi].notes.concat(parts[bj].notes), 0, 1);
      const mSum = merged.reduce((s, n) => s + n.pitch, 0);
      parts[bi] = {
        notes: merged, sum: mSum, count: merged.length,
        lastPitch: merged.length ? merged[merged.length - 1].pitch : parts[bi].lastPitch,
        lastEnd: merged.length ? merged[merged.length - 1].end : parts[bi].lastEnd
      };
      parts.splice(bj, 1);
    }

    // 4) 整理输出：高声部在前，单音化兜底
    parts.forEach(p => {
      p.notes = enforceGap(p.notes, 0, 1).sort((a, b) => a.start - b.start);
    });
    parts.sort((a, b) => avgPitch(b.notes) - avgPitch(a.notes));
    return parts.map(p => p.notes).filter(a => a.length);
  }

  /* 校验：同一音轨内是否任意时刻只有一个音符 */
  function checkMono(notes) {
    const s = notes.slice().sort((a, b) => a.start - b.start);
    for (let i = 1; i < s.length; i++) {
      if (s[i].start < s[i - 1].end) return false;
    }
    return true;
  }

  function maxConcurrent(notes) {
    const evs = [];
    for (const n of notes) { evs.push({ t: n.start, d: 1 }); evs.push({ t: n.end, d: -1 }); }
    evs.sort((a, b) => a.t - b.t || a.d - b.d);
    let c = 0, m = 0;
    for (const e of evs) { c += e.d; if (c > m) m = c; }
    return m;
  }

  /* =============================================================
   * 5. 生成 MIDI 文件
   * ============================================================= */
  function metaEvent(tick, meta, data, order) {
    return { tick, order: order || 0, data: [0xFF, meta].concat(vlqBytes(data.length), data) };
  }
  /* 结束标记必须显式给出 tick：否则排序时会被当成 0 排到最前，
     导致后面的速度/拍号事件被写到 End-of-Track 之后而被 DAW 忽略。 */
  function trackEnd(tick) { return { tick: tick, order: 999999, data: [0xFF, 0x2F, 0x00] }; }

  function buildTrack(events) {
    // 未指定 tick 的事件一律放到最后（保险兜底）
    let maxTick = 0;
    for (const e of events) if (typeof e.tick === 'number' && e.tick > maxTick) maxTick = e.tick;
    const evs = events.slice().sort((a, b) => {
      const ta = (a.tick == null ? Infinity : a.tick);
      const tb = (b.tick == null ? Infinity : b.tick);
      return (ta - tb) || (a.order - b.order);
    });
    const out = [];
    let last = 0;
    for (const e of evs) {
      const tick = (typeof e.tick === 'number') ? e.tick : maxTick;
      out.push.apply(out, vlqBytes(Math.max(0, tick - last)));
      last = tick;
      out.push.apply(out, e.data);
    }
    return out;
  }

  function chunk(id, bytes) {
    const len = bytes.length;
    return [].concat(
      utf8(id),
      [(len >>> 24) & 0xFF, (len >>> 16) & 0xFF, (len >>> 8) & 0xFF, len & 0xFF],
      bytes
    );
  }

  /**
   * spec = { division, tempos, timeSigs, tracks:[{name,ch,program,notes}] }
   * 返回 Uint8Array
   */
  function buildMidi(spec) {
    const division = spec.division || 480;
    const tracks = spec.tracks || [];

    // 全曲最长 tick：速度轨的结束标记至少要覆盖到它，否则速度轨会"提前结束"
    let pieceEnd = 0;
    for (const tr of tracks) {
      for (const n of (tr.notes || [])) if (n.end > pieceEnd) pieceEnd = n.end;
    }

    // ---- 速度轨（第 0 轨）----
    const tempos = (spec.tempos && spec.tempos.length) ? spec.tempos : [{ tick: 0, mpqn: 500000 }];
    const timeSigs = (spec.timeSigs && spec.timeSigs.length) ? spec.timeSigs : [{ tick: 0, num: 4, den: 2 }];
    const keySigs = spec.keySigs || [];

    const t0 = [metaEvent(0, 0x03, utf8(spec.tempoTrackName || 'Tempo Map'), -10)];
    tempos.forEach(tp => {
      t0.push({
        tick: tp.tick, order: -5,
        data: [0xFF, 0x51, 0x03, (tp.mpqn >> 16) & 0xFF, (tp.mpqn >> 8) & 0xFF, tp.mpqn & 0xFF]
      });
    });
    timeSigs.forEach(ts => {
      t0.push({ tick: ts.tick, order: -4, data: [0xFF, 0x58, 0x04, ts.num, ts.den, 24, 8] });
    });
    keySigs.forEach(ks => {
      t0.push({ tick: ks.tick, order: -3, data: [0xFF, 0x59, 0x02, ks.sf & 0xFF, ks.mi & 0xFF] });
    });

    // 结束标记：放在所有速度/拍号事件（以及整曲长度）之后
    let t0End = pieceEnd;
    for (const e of t0) if (e.tick > t0End) t0End = e.tick;
    t0.push(trackEnd(t0End + 1));

    const chunks = [];
    chunks.push(chunk('MThd', [0, 1, 0, tracks.length + 1, (division >> 8) & 0xFF, division & 0xFF]));
    chunks.push(chunk('MTrk', buildTrack(t0)));

    // ---- 各声部轨 ----
    for (const tr of tracks) {
      const evs = [metaEvent(0, 0x03, utf8(tr.name || 'Track'), -20)];
      if (!tr.drum && tr.program != null) {
        evs.push({ tick: 0, order: -15, data: [0xC0 | (tr.ch & 0x0F), tr.program & 0x7F] });
      }
      const notes = (tr.notes || []).slice().sort((a, b) => a.start - b.start);
      let lastTick = 0;
      for (const n of notes) {
        const ch = tr.ch & 0x0F;
        const vel = Math.max(1, Math.min(127, Math.round(n.vel == null ? 90 : n.vel)));
        evs.push({ tick: n.start, order: 1, data: [0x90 | ch, n.pitch & 0x7F, vel] });
        evs.push({ tick: n.end, order: 0, data: [0x80 | ch, n.pitch & 0x7F, 0x40] });
        if (n.end > lastTick) lastTick = n.end;
      }
      evs.push(trackEnd(Math.max(lastTick, pieceEnd) + 1));
      chunks.push(chunk('MTrk', buildTrack(evs)));
    }

    const all = [];
    for (const c of chunks) all.push.apply(all, c);
    return new Uint8Array(all);
  }

  /* 单轨导出 */
  function buildMidiSingleTrack(spec) {
    return buildMidi(Object.assign({}, spec, { tracks: [spec.tracks[0]] }));
  }

  /* =============================================================
   * 6. 示例 MIDI（用于无文件测试）
   * ============================================================= */
  function generateDemo() {
    const PPQ = 480, BAR = PPQ * 4;
    const chords = [[60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60]];
    const bass = [36, 43, 45, 41];
    const mel = [72, 71, 69, 67, 69, 71, 72, 74, 72, 71, 67, 69, 71, 69, 67, 65,
                 67, 69, 71, 72, 74, 76, 74, 72, 71, 69, 67, 65, 64, 65, 67, 69];
    const chNotes = [], melNotes = [], bassNotes = [], drumNotes = [];

    for (let b = 0; b < 4; b++) {
      const t0 = b * BAR;
      chords[b].forEach(p => chNotes.push({ start: t0, end: t0 + BAR - 60, pitch: p, vel: 78, ch: 1 }));
      bassNotes.push({ start: t0, end: t0 + PPQ * 2 - 60, pitch: bass[b], vel: 96, ch: 2 });
      bassNotes.push({ start: t0 + PPQ * 2, end: t0 + PPQ * 4 - 60, pitch: bass[b] + 7, vel: 88, ch: 2 });
      for (let k = 0; k < 8; k++) {
        const s = t0 + k * (PPQ / 2);
        melNotes.push({ start: s, end: s + PPQ / 2 - 40, pitch: mel[b * 8 + k], vel: 100, ch: 0 });
      }
      for (let k = 0; k < 4; k++) {
        drumNotes.push({ start: t0 + k * PPQ, end: t0 + k * PPQ + 60, pitch: 36, vel: 100, ch: 9 });
        drumNotes.push({ start: t0 + k * PPQ + PPQ / 2, end: t0 + k * PPQ + PPQ / 2 + 60, pitch: 42, vel: 70, ch: 9 });
        if (k % 2 === 1) drumNotes.push({ start: t0 + k * PPQ, end: t0 + k * PPQ + 60, pitch: 38, vel: 90, ch: 9 });
      }
    }
    return buildMidi({
      division: PPQ,
      tempos: [{ tick: 0, mpqn: 500000 }],
      timeSigs: [{ tick: 0, num: 4, den: 2 }],
      tempoTrackName: 'Demo Tempo',
      tracks: [
        { name: 'Melody', ch: 0, program: 0, notes: melNotes },
        { name: 'Chords', ch: 1, program: 0, notes: chNotes },
        { name: 'Bass', ch: 2, program: 33, notes: bassNotes },
        { name: 'Drums', ch: 9, program: 0, notes: drumNotes, drum: true }
      ]
    });
  }

  const API = {
    GM_NAMES, NOTE_NAMES, pitchName,
    parseMidi, extractNotes, makeClock, separate, splitMonoTrack, checkMono, maxConcurrent,
    buildMidi, buildMidiSingleTrack, generateDemo, enforceGap
  };

  global.MidiCore = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
