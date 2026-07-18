/**
 * n 以上の最小の 2 のべき乗を返す。
 * deepslate の upperPowerOfTwo はビット演算で float を truncate するため、
 * sqrt(N) が整数でない場合に atlas サイズが小さくなるバグを回避するために使う。
 */
export function nextPow2(n: number): number {
  let p = 1
  while (p < n) p *= 2
  return p
}

/**
 * TextureAtlas.fromBlobs を呼ぶ前に textureBlobs を padding して
 * deepslate の upperPowerOfTwo バグを回避する。
 *
 * deepslate の fromBlobs は atlas 幅を upperPowerOfTwo(sqrt(N+1)) で決めるが、
 * upperPowerOfTwo がビット演算で float を truncate するため、
 * N+1 が完全平方数でないと atlas が小さすぎてテクスチャがはみ出す。
 * 例: N=20 → sqrt(21)≈4.58 → upperPOT(4.58)=4 → 4×4=16 スロット不足
 *
 * 対策: テクスチャ数を「次の正しい幅の二乗 - 1」個になるよう、
 * 既存の Blob を使い回してダミーエントリで埋める。
 */
export function padTextureBlobs(textureBlobs: Record<string, Blob>): void {
  const actualN = Object.keys(textureBlobs).length
  const neededW = nextPow2(Math.ceil(Math.sqrt(actualN + 1)))
  const neededSlots = neededW * neededW - 1 // index 0 は invalid texture 用

  if (actualN >= neededSlots) return

  const firstKey = Object.keys(textureBlobs)[0]
  if (!firstKey) return

  const dummyBlob = textureBlobs[firstKey]
  let p = 0
  while (Object.keys(textureBlobs).length < neededSlots) {
    textureBlobs[`__pad__${p++}`] = dummyBlob
  }
  console.log(`[atlasUtils] atlas padding: ${actualN} → ${neededSlots} (width=${neededW})`)
}
