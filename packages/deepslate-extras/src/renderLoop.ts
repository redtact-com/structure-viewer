// rAF 描画ループの dirty-flag 制御。
//
// 素朴な実装は draw 末尾で無条件に requestAnimationFrame を再帰予約するため、
// カメラ静止時も 60fps で clear + 全チャンク描画が走り続ける
// (同一ページに複数ビューアーを置くとその数だけループが並走する)。
//
// 方式は「dirty が無ければ rAF 自体を止め、契機 (invalidate) で再開する」。
// 「ループは回して draw だけスキップ」より省電力で、かつ本実装では
// dirty を立てる経路が invalidate() の 1 本に集約されており、
// invalidate は常に schedule も兼ねるため「フラグは立てたがループが
// 止まったままで再開されない」という取りこぼしが構造的に起きない。
// 継続駆動が必要な状態 (フライモードの WASD 連続移動) は isContinuous で
// 毎フレーム自動的に次フレームを予約する。

export interface RenderLoopOptions {
  /** 1 フレーム分の描画。dirty または継続駆動状態のフレームでのみ呼ばれる。 */
  draw: () => void;
  /**
   * true を返す間は毎フレーム描画を続ける (例: フライモード + ポインターロック中。
   * WASD の押しっぱなし移動はイベントではなくフレーム毎のキー状態参照で動くため)。
   */
  isContinuous?: () => boolean;
  /** テスト用の rAF 差し替え。省略時は requestAnimationFrame。 */
  requestFrame?: (cb: () => void) => number;
  /** テスト用の cancelAnimationFrame 差し替え。 */
  cancelFrame?: (id: number) => void;
}

export interface RenderLoop {
  /**
   * 再描画が必要になったことを通知する。停止中のループも再開する
   * (一時停止中は dirty だけ積み、再開時に 1 フレーム描画される)。
   */
  invalidate(): void;
  /**
   * viewport 外に出た時などの一時停止/再開。再開時は必ず 1 フレーム描画する
   * (停止中に取りこぼした変更を反映するため)。
   */
  setPaused(paused: boolean): void;
  /** ループを完全に停止する (unmount 用)。以後の invalidate は無視される。 */
  dispose(): void;
  /** rAF が予約されているか (テスト用)。 */
  isScheduled(): boolean;
}

export function createRenderLoop(options: RenderLoopOptions): RenderLoop {
  const requestFrame = options.requestFrame ?? ((cb: () => void) => requestAnimationFrame(cb));
  const cancelFrame = options.cancelFrame ?? ((id: number) => cancelAnimationFrame(id));

  let rafId: number | null = null;
  let dirty = false;
  let paused = false;
  let disposed = false;

  const schedule = () => {
    if (disposed || paused || rafId !== null) return;
    rafId = requestFrame(frame);
  };

  const frame = () => {
    rafId = null;
    if (disposed || paused) return;
    const continuous = options.isContinuous?.() ?? false;
    if (dirty || continuous) {
      dirty = false;
      options.draw();
    }
    // 継続駆動中、または draw 中に invalidate された場合は次フレームを予約する
    // (invalidate 側も schedule するが rafId ガードで二重予約にはならない)。
    if (continuous || dirty) schedule();
  };

  const cancelPending = () => {
    if (rafId !== null) {
      cancelFrame(rafId);
      rafId = null;
    }
  };

  return {
    invalidate() {
      if (disposed) return;
      dirty = true;
      schedule();
    },
    setPaused(next: boolean) {
      if (disposed || paused === next) return;
      paused = next;
      if (next) {
        cancelPending();
      } else {
        dirty = true;
        schedule();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelPending();
    },
    isScheduled: () => rafId !== null,
  };
}
