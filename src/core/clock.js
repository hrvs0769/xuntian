// 时间：真实儒略日驱动；可播放/暂停/变速/定位
import { dateToJd } from './ephemeris.js';

export const RATES = [
  { days: 1 / 24, label: '1 时', short: '1时' },
  { days: 1, label: '1 天', short: '1天' },
  { days: 30, label: '1 月', short: '1月' },
  { days: 365, label: '1 年', short: '1年' },
];

export class Clock {
  constructor() {
    this.jd = dateToJd(new Date());
    this.home = this.jd;
    this.rateIndex = 1;
    this.running = false;
  }

  get rate() { return RATES[this.rateIndex].days; }
  get rateLabel() { return RATES[this.rateIndex].label; }

  tick(dt) {
    if (this.running) this.jd += this.rate * dt;
  }

  play() { this.running = true; }
  pause() { this.running = false; }
  toggle() { this.running = !this.running; return this.running; }

  setRate(i) { this.rateIndex = Math.max(0, Math.min(RATES.length - 1, i)); }
  rateUp() { this.setRate(this.rateIndex + 1); }
  rateDown() { this.setRate(this.rateIndex - 1); }

  seek(jd) { this.jd = jd; }
  resetNow() { this.jd = dateToJd(new Date()); this.home = this.jd; }
}
