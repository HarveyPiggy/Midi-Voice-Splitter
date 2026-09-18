/* =============================================================
 * synth.js —— 离线试听引擎（零外部音色文件）
 *   · 非打击乐轨：加法合成的钢琴音色（谐波 + 击槌瞬态 + 低通）
 *   · 打击乐轨（可选）：极简鼓合成
 *   · MidiPlayer：Web Audio 前瞻调度 + 变速 / 循环 / 静音 / 独奏
 * ============================================================= */
(function (global) {
  'use strict';

  /* ---------- 生成用的缓冲（混响 IR / 白噪声） ---------- */
  function makeIR(ctx, sec, decay) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * sec));
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (1 - t * 0.15);
      }
    }
    return buf;
  }
  function makeNoise(ctx, sec) {
    const len = Math.floor(ctx.sampleRate * sec);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /* =============================================================
   * 音色引擎
   * ============================================================= */
  class SynthEngine {
    constructor() {
      this.ctx = null;
      this.bus = null;
      this.master = null;
      this.noise = null;
      this.voices = new Set();
      this.volume = 0.85;
      this.drums = true;
    }

    ensure() {
      if (this.ctx) {
        if (this.ctx.state === 'suspended') this.ctx.resume();
        return this.ctx;
      }
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) throw new Error('当前浏览器不支持 Web Audio API');
      const ctx = new AC();

      const master = ctx.createGain();
      master.gain.value = this.volume;

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.knee.value = 14;
      comp.ratio.value = 4;
      comp.attack.value = 0.004;
      comp.release.value = 0.25;

      const bus = ctx.createGain();
      bus.gain.value = 1;

      // 一点点房间感（ procedurally 生成 IR，不加载文件）
      const conv = ctx.createConvolver();
      conv.buffer = makeIR(ctx, 1.6, 3.2);
      const wet = ctx.createGain();
      wet.gain.value = 0.17;

      bus.connect(comp);
      bus.connect(conv);
      conv.connect(wet);
      wet.connect(comp);
      comp.connect(master);
      master.connect(ctx.destination);

      this.ctx = ctx;
      this.bus = bus;
      this.master = master;
      this.comp = comp;
      this.noise = makeNoise(ctx, 1.5);
      return ctx;
    }

    setVolume(v) {
      this.volume = v;
      if (this.master) this.master.gain.value = v;
    }
    setDrums(on) { this.drums = !!on; }

    /* 统一登记发声体，便于「停止」时统一收尾 */
    _register(endTime, cutFn) {
      const v = { endTime, cut: cutFn, dead: false };
      this.voices.add(v);
      const ms = Math.max(0, (endTime - this.ctx.currentTime) * 1000 + 400);
      setTimeout(() => { v.dead = true; this.voices.delete(v); }, ms);
    }

    allOff() {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      this.voices.forEach(v => { if (!v.dead) { try { v.cut(now); } catch (e) { } } });
      this.voices.clear();
    }

    /* ---------------- 钢琴（加法合成） ---------------- */
    piano(pitch, vel, t0, dur) {
      const ctx = this.ensure();
      const v = Math.max(0.06, Math.min(1, (vel || 90) / 127));
      const f = 440 * Math.pow(2, (pitch - 69) / 12);
      const hold = Math.max(0.06, dur || 0.4);
      const rel = t0 + hold;

      const out = ctx.createGain();
      out.gain.value = 1;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = Math.min(15000, f * 5 + 1400 + 5200 * v * v);
      lp.Q.value = 0.25;
      out.connect(lp);
      lp.connect(this.bus);

      const HARM = [1, 2, 3, 4, 5, 6];
      const AMP = [1, 0.44, 0.26, 0.15, 0.09, 0.055];
      const DEC = [1, 1.3, 1.7, 2.1, 2.6, 3.2];
      const bright = 0.5 + 0.62 * v;
      const nH = pitch < 45 ? 6 : (pitch < 70 ? 5 : 4);

      const stopAt = rel + 1.6;
      for (let h = 0; h < nH; h++) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = f * HARM[h] * (1 + 0.0007 * h);
        const g = ctx.createGain();
        const peak = Math.max(0.0008, AMP[h] * Math.pow(bright, h) * 0.55 * v);
        let decay = 2.4 / DEC[h] * (0.45 + pitch / 190);
        // 衰减点必须早于释放点，否则自动化事件顺序会被打乱
        decay = Math.max(0.015, Math.min(decay, hold * 0.9));
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(peak, t0 + 0.006);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0004, peak * 0.22), t0 + decay);
        g.gain.setTargetAtTime(0.00006, rel, 0.09 + pitch / 1400);
        o.connect(g); g.connect(out);
        o.start(t0);
        o.stop(stopAt);
      }

      // 击槌瞬态（很轻微的噪声，让起音有"槌"的感觉）
      if (this.noise && pitch >= 24) {
        const n = ctx.createBufferSource();
        n.buffer = this.noise;
        const nf = ctx.createBiquadFilter();
        nf.type = 'bandpass';
        nf.frequency.value = Math.min(9000, f * 3 + 1200);
        nf.Q.value = 0.7;
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(0.0001, t0);
        ng.gain.exponentialRampToValueAtTime(0.045 * v * v, t0 + 0.003);
        ng.gain.exponentialRampToValueAtTime(0.00006, t0 + 0.06);
        n.connect(nf); nf.connect(ng); ng.connect(out);
        n.start(t0, Math.random() * 0.6);
        n.stop(t0 + 0.1);
      }

      this._register(stopAt, when => {
        try {
          out.gain.cancelScheduledValues(when);
          out.gain.setTargetAtTime(0.0001, when, 0.02);
        } catch (e) { }
      });
    }

    /* ---------------- 极简鼓合成 ---------------- */
    drum(pitch, vel, t0) {
      const ctx = this.ensure();
      const v = Math.max(0.06, Math.min(1, (vel || 90) / 127));
      const out = ctx.createGain();
      out.gain.value = 1;
      out.connect(this.bus);
      let stopAt = t0 + 0.4;

      const tone = (f0, f1, dur, amp) => {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(f0, t0);
        o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur * 0.8);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(Math.max(0.001, amp), t0 + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        o.connect(g); g.connect(out);
        o.start(t0); o.stop(t0 + dur + 0.05);
        stopAt = Math.max(stopAt, t0 + dur + 0.05);
      };
      const noiseHit = (type, freq, q, dur, amp) => {
        const n = ctx.createBufferSource();
        n.buffer = this.noise;
        const f = ctx.createBiquadFilter();
        f.type = type; f.frequency.value = freq; f.Q.value = q;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(Math.max(0.001, amp), t0 + 0.003);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        n.connect(f); f.connect(g); g.connect(out);
        n.start(t0, Math.random() * 0.5);
        n.stop(t0 + dur + 0.02);
        stopAt = Math.max(stopAt, t0 + dur + 0.02);
      };

      if (pitch === 35 || pitch === 36) {                       // 底鼓
        tone(160, 46, 0.42, 0.85 * v); noiseHit('lowpass', 320, 1, 0.05, 0.16 * v);
      } else if (pitch === 38 || pitch === 40) {                // 军鼓
        noiseHit('bandpass', 1900, 0.85, 0.19, 0.5 * v); tone(215, 175, 0.11, 0.32 * v);
      } else if (pitch === 42 || pitch === 44) {                // 闭合踩镲
        noiseHit('highpass', 7800, 0.8, 0.05, 0.3 * v);
      } else if (pitch === 46) {                                // 开镲
        noiseHit('highpass', 7000, 0.8, 0.34, 0.28 * v);
      } else if (pitch === 49 || pitch === 51 || pitch === 57 || pitch === 59) { // 镲 / 叮叮
        noiseHit('highpass', 5200, 0.7, 0.9, 0.24 * v);
      } else if (pitch >= 41 && pitch <= 50) {                  // 通鼓
        tone(250 - (pitch - 41) * 12, 95, 0.28, 0.45 * v);
      } else {
        tone(320, 130, 0.2, 0.3 * v);
      }

      this._register(stopAt, when => {
        try {
          out.gain.cancelScheduledValues(when);
          out.gain.setTargetAtTime(0.0001, when, 0.015);
        } catch (e) { }
      });
    }
  }

  /* =============================================================
   * 播放器：把 (tick → 秒) 后的音符表按 Web Audio 时间轴前瞻调度
   * ============================================================= */
  class MidiPlayer {
    constructor(engine) {
      this.e = engine;
      this.events = [];
      this.dur = 0;
      this.idx = 0;
      this.offset = 0;
      this.playing = false;
      this.startCtx = 0;
      this.timer = null;
      this.loop = false;
      this.rate = 1;
      this.mute = new Set();
      this.solo = new Set();
      this.onState = null;
    }

    /* tracks: [{notes, drum}]，tickToSec(tick)->秒 */
    setMaterial(tracks, tickToSec, maxTick) {
      const evs = [];
      tracks.forEach((t, i) => {
        t.notes.forEach(n => {
          const s = tickToSec(n.start), en = tickToSec(n.end);
          evs.push({
            t: s, i, pitch: n.pitch, vel: n.vel == null ? 90 : n.vel,
            dur: Math.max(0.05, en - s), drum: !!t.drum
          });
        });
      });
      evs.sort((a, b) => a.t - b.t);
      this.events = evs;
      this.dur = Math.max(0.001, tickToSec(maxTick));
      this.idx = 0;
      this.offset = 0;
      this.mute.clear();
      this.solo.clear();
    }

    audible(i) {
      if (this.mute.has(i)) return false;
      if (this.solo.size) return this.solo.has(i);
      return true;
    }
    position() {
      if (!this.playing || !this.e.ctx) return this.offset;
      return (this.e.ctx.currentTime - this.startCtx) * this.rate + this.offset;
    }
    _seekIndex(sec) {
      let i = 0;
      while (i < this.events.length && this.events[i].t < sec) i++;
      return i;
    }

    play() {
      if (this.playing || !this.events.length) return;
      const ctx = this.e.ensure();
      this.idx = this._seekIndex(this.offset);
      this.startCtx = ctx.currentTime + 0.08;
      this.playing = true;
      this._tick();
      this.timer = setInterval(() => this._tick(), 25);
      if (this.onState) this.onState();
    }

    pause() {
      if (!this.playing) return;
      this.offset = Math.min(this.dur, Math.max(0, this.position()));
      this._halt();
      if (this.onState) this.onState();
    }

    stop() {
      this._halt();
      this.offset = 0;
      this.idx = this._seekIndex(0);
      if (this.onState) this.onState();
    }

    seek(sec) {
      sec = Math.min(this.dur, Math.max(0, sec));
      const was = this.playing;
      this._halt();
      this.offset = sec;
      this.idx = this._seekIndex(sec);
      if (was) this.play();
      else if (this.onState) this.onState();
    }

    _halt() {
      this.playing = false;
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      this.e.allOff();
    }

    _tick() {
      if (!this.playing) return;
      const ctx = this.e.ctx;
      const horizon = this.position() + 0.18;
      while (this.idx < this.events.length && this.events[this.idx].t <= horizon) {
        const ev = this.events[this.idx++];
        const when = Math.max(ctx.currentTime + 0.005, this.startCtx + (ev.t - this.offset) / this.rate);
        if (!this.audible(ev.i)) continue;
        if (ev.drum) { if (this.e.drums) this.e.drum(ev.pitch, ev.vel, when); }
        else this.e.piano(ev.pitch, ev.vel, when, ev.dur / this.rate);
      }
      if (this.position() > this.dur + 0.8) {
        if (this.loop) {
          this.offset = 0;
          this.idx = 0;
          this.startCtx = ctx.currentTime + 0.05;
        } else {
          this.stop();
          return;
        }
      }
    }
  }

  global.Synth = { SynthEngine, MidiPlayer };
  if (typeof module !== 'undefined' && module.exports) module.exports = { SynthEngine, MidiPlayer };
})(typeof globalThis !== 'undefined' ? globalThis : this);
