// 时间轴：±365 天窗口，可拖动定位
import { RATES } from '../core/clock.js';
import { jdToDate, formatJd } from '../core/ephemeris.js';

const SPAN = 365;

export class Timebar {
  constructor({ clock, onSeek, onChange }) {
    this.clock = clock;
    this.onSeek = onSeek;
    this.onChange = onChange;

    this.track = document.getElementById('tb-track');
    this.fill = document.getElementById('tb-fill');
    this.knob = document.getElementById('tb-knob');
    this.ticks = document.getElementById('tb-ticks');
    this.date = document.getElementById('tb-date');
    this.rateEl = document.getElementById('tb-rate');
    this.playBtn = document.getElementById('tb-play');
    this.ratesEl = document.getElementById('tb-rates');
    this.bar = document.getElementById('timebar');

    this._dragging = false;
    this._buildTicks();
    this._buildRates();

    this.playBtn.addEventListener('click', () => {
      this.clock.toggle();
      this._syncPlay();
      this._notify();
    });

    document.getElementById('tb-now').addEventListener('click', () => {
      this.clock.resetNow();
      this._buildTicks();
      this._sync();
      this._notify();
    });

    this.track.addEventListener('pointerdown', (e) => {
      this.track.setPointerCapture(e.pointerId);
      this._dragging = true;
      this.bar.classList.add('is-active');
      this._seekFromEvent(e);
    });
    this.track.addEventListener('pointermove', (e) => {
      if (this._dragging) this._seekFromEvent(e);
    });
    const end = () => { this._dragging = false; this.bar.classList.remove('is-active'); };
    this.track.addEventListener('pointerup', end);
    this.track.addEventListener('pointercancel', end);

    this._syncPlay();
  }

  _notify() { if (this.onChange) this.onChange(); }

  _seekFromEvent(e) {
    const r = this.track.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const jd = this.clock.home - SPAN + t * SPAN * 2;
    this.clock.seek(jd);
    if (this.onSeek) this.onSeek(jd);
    this._sync();
  }

  _buildTicks() {
    this.ticks.innerHTML = '';
    const marks = [
      [-SPAN, '−1 年'], [-SPAN / 2, '−6 月'], [0, '此刻'], [SPAN / 2, '+6 月'], [SPAN, '+1 年'],
    ];
    for (const [d, label] of marks) {
      const el = document.createElement('div');
      el.className = 'tb-tick';
      el.style.left = `${((d + SPAN) / (SPAN * 2)) * 100}%`;
      el.innerHTML = `<span>${label}</span>`;
      this.ticks.appendChild(el);
    }
  }

  _buildRates() {
    this.ratesEl.innerHTML = '';
    RATES.forEach((r, i) => {
      const b = document.createElement('button');
      b.className = 'rate-chip';
      b.textContent = r.short;
      b.dataset.i = i;
      b.addEventListener('click', () => {
        this.clock.setRate(i);
        this.clock.play();
        this._syncPlay();
        this._sync();
        this._notify();
      });
      this.ratesEl.appendChild(b);
    });
  }

  _syncPlay() {
    this.playBtn.classList.toggle('is-playing', this.clock.running);
    this.playBtn.setAttribute('aria-label', this.clock.running ? '暂停' : '播放');
  }

  _sync() {
    const t = (this.clock.jd - (this.clock.home - SPAN)) / (SPAN * 2);
    const p = Math.max(0, Math.min(1, t));
    this.fill.style.width = `${p * 100}%`;
    this.knob.style.left = `${p * 100}%`;
    this.date.textContent = formatJd(this.clock.jd);
    this.rateEl.textContent = `1 秒 = ${this.clock.rateLabel}`;
    [...this.ratesEl.children].forEach((c, i) => {
      c.classList.toggle('is-on', i === this.clock.rateIndex && this.clock.running);
    });
  }

  update() { this._sync(); }
}
