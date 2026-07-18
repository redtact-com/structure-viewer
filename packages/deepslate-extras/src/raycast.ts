// ピックモード用のレイキャスト群。
// gl-matrix だけに依存する純粋関数で、3D ビューアでブロックを射的選択するのに使う。
import { mat4 } from "gl-matrix";

const INF = 1e30;
const FOV_F = 1 / Math.tan((70 * Math.PI) / 180 / 2); // deepslate の FOV = 70°

/**
 * DDA (Amanatides & Woo) でレイとボクセルグリッドの交差を求める。
 * - 開始ボクセル (カメラが入っているボクセル) は必ずスキップ。
 * - 構造体範囲外はスキップするが break しない (カメラが外にいても正しく動く)。
 * - materialSet が指定されていれば、それ以外のブロックは透過 (無視)。
 */
export function ddaRaycast(
  origin: readonly [number, number, number],
  dir: readonly [number, number, number],
  blockMap: ReadonlyMap<string, string>,
  materialSet: ReadonlySet<string> | null,
  size: readonly [number, number, number],
  maxDist = 48,
): [number, number, number] | null {
  let x = Math.floor(origin[0]);
  let y = Math.floor(origin[1]);
  let z = Math.floor(origin[2]);

  const stepX = dir[0] >= 0 ? 1 : -1;
  const stepY = dir[1] >= 0 ? 1 : -1;
  const stepZ = dir[2] >= 0 ? 1 : -1;

  const tDeltaX = Math.abs(dir[0]) < 1e-10 ? INF : 1 / Math.abs(dir[0]);
  const tDeltaY = Math.abs(dir[1]) < 1e-10 ? INF : 1 / Math.abs(dir[1]);
  const tDeltaZ = Math.abs(dir[2]) < 1e-10 ? INF : 1 / Math.abs(dir[2]);

  const ox = origin[0],
    oy = origin[1],
    oz = origin[2];
  let tMaxX = tDeltaX === INF ? INF : (stepX > 0 ? x + 1 - ox : ox - x) * tDeltaX;
  let tMaxY = tDeltaY === INF ? INF : (stepY > 0 ? y + 1 - oy : oy - y) * tDeltaY;
  let tMaxZ = tDeltaZ === INF ? INF : (stepZ > 0 ? z + 1 - oz : oz - z) * tDeltaZ;

  for (let i = 0; i < 512; i++) {
    const t = Math.min(tMaxX, tMaxY, tMaxZ);
    if (t > maxDist) break;

    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      tMaxX += tDeltaX;
      x += stepX;
    } else if (tMaxY <= tMaxZ) {
      tMaxY += tDeltaY;
      y += stepY;
    } else {
      tMaxZ += tDeltaZ;
      z += stepZ;
    }

    if (x < 0 || x >= size[0] || y < 0 || y >= size[1] || z < 0 || z >= size[2]) continue;

    const name = blockMap.get(`${x},${y},${z}`);
    if (!name) continue;
    if (materialSet && !materialSet.has(name)) continue;

    return [x, y, z];
  }
  return null;
}

/**
 * オービットカメラのビュー行列とキャンバス上のマウス座標から
 * ワールド空間のレイ (原点・方向) を計算する。
 */
export function cameraRayFromMouse(
  mouseX: number,
  mouseY: number,
  canvasW: number,
  canvasH: number,
  viewMatrix: mat4,
): { origin: [number, number, number]; dir: [number, number, number] } {
  const inv = mat4.create();
  if (!mat4.invert(inv, viewMatrix)) {
    return { origin: [0, 0, 0], dir: [0, 0, -1] };
  }

  // カメラのワールド座標 (逆行列の平行移動成分)
  const origin: [number, number, number] = [inv[12], inv[13], inv[14]];

  // NDC → ビュー空間レイ方向 (deepslate FOV 70°)
  const aspect = canvasW / canvasH;
  const nx = (mouseX / canvasW) * 2 - 1;
  const ny = -(mouseY / canvasH) * 2 + 1; // Y 反転
  const vx = (nx * aspect) / FOV_F;
  const vy = ny / FOV_F;
  const vz = -1.0;

  // ビュー空間 → ワールド空間 (逆行列の回転部分のみ)
  const wx = inv[0] * vx + inv[4] * vy + inv[8] * vz;
  const wy = inv[1] * vx + inv[5] * vy + inv[9] * vz;
  const wz = inv[2] * vx + inv[6] * vy + inv[10] * vz;
  const wlen = Math.sqrt(wx * wx + wy * wy + wz * wz);

  return {
    origin,
    dir: [wx / wlen, wy / wlen, wz / wlen],
  };
}

export function posKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

/**
 * グリッドセルが直方体の辺上 (2 軸以上が端値) かどうかを判定する。
 */
export function isOnAABBEdge(
  pos: readonly [number, number, number],
  size: readonly [number, number, number],
): boolean {
  let count = 0;
  if (pos[0] === 0 || pos[0] === size[0] - 1) count++;
  if (pos[1] === 0 || pos[1] === size[1] - 1) count++;
  if (pos[2] === 0 || pos[2] === size[2] - 1) count++;
  return count >= 2;
}

/**
 * レイが構造体の境界ボックスに最初に入るグリッドセルを返す。
 * ブロックの有無に関わらず位置を返すため、ドラッグ選択の開始・終了点として使用する。
 * カメラが構造体内部にいる場合はカメラ位置のグリッドセルを返す。
 */
export function rayToStructureEntry(
  origin: readonly [number, number, number],
  dir: readonly [number, number, number],
  size: readonly [number, number, number],
): [number, number, number] | null {
  const [ox, oy, oz] = origin;
  const [dx, dy, dz] = dir;
  const [sx, sy, sz] = size;

  if (ox >= 0 && ox < sx && oy >= 0 && oy < sy && oz >= 0 && oz < sz) {
    return [Math.floor(ox), Math.floor(oy), Math.floor(oz)];
  }

  let tMin = 0;
  let tMax = Infinity;
  for (const [o, d, s] of [
    [ox, dx, sx],
    [oy, dy, sy],
    [oz, dz, sz],
  ] as [number, number, number][]) {
    if (Math.abs(d) < 1e-10) {
      if (o < 0 || o >= s) return null;
    } else {
      const t1 = (0 - o) / d;
      const t2 = (s - o) / d;
      tMin = Math.max(tMin, Math.min(t1, t2));
      tMax = Math.min(tMax, Math.max(t1, t2));
    }
  }
  if (tMin > tMax) return null;

  const t = tMin + 1e-4;
  const bx = Math.max(0, Math.min(sx - 1, Math.floor(ox + dx * t)));
  const by = Math.max(0, Math.min(sy - 1, Math.floor(oy + dy * t)));
  const bz = Math.max(0, Math.min(sz - 1, Math.floor(oz + dz * t)));
  return [bx, by, bz];
}
