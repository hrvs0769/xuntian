// 星历：astronomy-engine → 场景坐标（1 单位 = 1 AU，黄道面 = XZ，Y 为黄道北）
import { HelioVector, GeoVector, Body } from 'astronomy-engine';

const OBLIQ = 23.4392911 * Math.PI / 180;
const COS_E = Math.cos(OBLIQ);
const SIN_E = Math.sin(OBLIQ);

export const AU_KM = 149597870.7;
export const J2000 = 2451545.0;

/** JS Date → 儒略日 */
export function dateToJd(d) {
  return d.getTime() / 86400000 + 2440587.5;
}
/** 儒略日 → JS Date */
export function jdToDate(jd) {
  return new Date((jd - 2440587.5) * 86400000);
}

// EQJ → 黄道 → 场景（X 春分点，Y 北，Z = -黄经90°）
function toScene(v) {
  const xe = v.x;
  const ye = v.y * COS_E + v.z * SIN_E;
  const ze = -v.y * SIN_E + v.z * COS_E;
  return { x: xe, y: ze, z: -ye };
}

const ABBR = {
  sun: 'Sun', mercury: 'Mercury', venus: 'Venus', earth: 'Earth', mars: 'Mars',
  jupiter: 'Jupiter', saturn: 'Saturn', uranus: 'Uranus', neptune: 'Neptune',
};

/** 行星日心位置（AU） */
export function helio(id, jd) {
  if (id === 'sun') return { x: 0, y: 0, z: 0 };
  const v = HelioVector(Body[ABBR[id]], jdToDate(jd));
  return toScene(v);
}

/** 月球地心位置（AU） */
export function moonGeo(jd) {
  const v = GeoVector(Body.Moon, jdToDate(jd), true);
  return toScene(v);
}

/** 一次性算出所有天体在场景中的位置（AU） */
export function positionsAt(jd) {
  const out = {};
  for (const id in ABBR) out[id] = helio(id, jd);
  const m = moonGeo(jd);
  const e = out.earth;
  out.moon = { x: e.x + m.x, y: e.y + m.y, z: e.z + m.z };
  return out;
}

/** 采样一条轨道（用于轨道线），返回 Float32Array 顶点 */
export function sampleOrbit(id, jd, periodDays, segments = 320) {
  const arr = new Float32Array(segments * 3);
  const step = periodDays / segments;
  for (let i = 0; i < segments; i++) {
    const p = helio(id, jd + i * step);
    arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z;
  }
  return arr;
}

/** 自转相位（弧度）：由儒略日与恒星自转周期决定 */
export function spinAngle(rotationDays, jd) {
  const days = jd - J2000;
  const sign = rotationDays >= 0 ? 1 : -1;
  const period = Math.abs(rotationDays);
  const turns = days / period;
  return sign * (turns - Math.floor(turns)) * Math.PI * 2;
}

export function formatJd(jd) {
  const d = jdToDate(jd);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}.${m}.${dd}`;
}
