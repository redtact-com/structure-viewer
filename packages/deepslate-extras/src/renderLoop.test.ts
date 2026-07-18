// @vitest-environment jsdom
// rAF dirty-flag ループ (renderLoop.ts) の駆動制御テスト。
// rAF をモックしてフレームを手動送りし、
// 「静止時は draw が呼ばれない / 入力 (invalidate) で再開する /
//  継続駆動 (フライモード) / viewport 外の一時停止 / dispose」を検証する。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRenderLoop } from "./renderLoop";

// requestAnimationFrame モック: 登録されたコールバックを flushFrame() で 1 フレーム分実行する
let pending: Map<number, () => void>;
let nextId: number;

const flushFrame = () => {
  const callbacks = [...pending.values()];
  pending.clear();
  for (const cb of callbacks) cb();
};

beforeEach(() => {
  pending = new Map();
  nextId = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextId++;
    pending.set(id, () => cb(0));
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    pending.delete(id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createRenderLoop", () => {
  it("静止時は draw が呼ばれず rAF 予約も残らない", () => {
    const draw = vi.fn();
    const loop = createRenderLoop({ draw });

    // 初回の invalidate で 1 フレームだけ描画される
    loop.invalidate();
    expect(loop.isScheduled()).toBe(true);
    flushFrame();
    expect(draw).toHaveBeenCalledTimes(1);

    // 以降は契機が無い限り rAF 予約が消え、フレームが来ても draw されない
    expect(loop.isScheduled()).toBe(false);
    flushFrame();
    flushFrame();
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it("入力 (invalidate) で再開し、1 フレームだけ描画して再び停止する", () => {
    const draw = vi.fn();
    const loop = createRenderLoop({ draw });
    loop.invalidate();
    flushFrame();
    expect(draw).toHaveBeenCalledTimes(1);
    expect(loop.isScheduled()).toBe(false);

    // カメラ入力相当の invalidate → ループ再開
    loop.invalidate();
    expect(loop.isScheduled()).toBe(true);
    flushFrame();
    expect(draw).toHaveBeenCalledTimes(2);
    expect(loop.isScheduled()).toBe(false);
  });

  it("フレーム間の複数 invalidate は 1 回の draw にまとめられる", () => {
    const draw = vi.fn();
    const loop = createRenderLoop({ draw });
    loop.invalidate();
    loop.invalidate();
    loop.invalidate();
    flushFrame();
    expect(draw).toHaveBeenCalledTimes(1);
    expect(loop.isScheduled()).toBe(false);
  });

  it("isContinuous が true の間は毎フレーム描画し、false に戻ると停止する", () => {
    const draw = vi.fn();
    let continuous = true;
    const loop = createRenderLoop({ draw, isContinuous: () => continuous });

    loop.invalidate();
    flushFrame();
    flushFrame();
    flushFrame();
    expect(draw).toHaveBeenCalledTimes(3);
    expect(loop.isScheduled()).toBe(true);

    // フライモード終了相当 → 次フレームで停止 (dirty も無いので draw されない)
    continuous = false;
    flushFrame();
    expect(draw).toHaveBeenCalledTimes(3);
    expect(loop.isScheduled()).toBe(false);
  });

  it("setPaused(true) で停止し、再開時は必ず 1 フレーム描画する", () => {
    const draw = vi.fn();
    const loop = createRenderLoop({ draw });
    loop.invalidate();
    flushFrame();
    expect(draw).toHaveBeenCalledTimes(1);

    // viewport 外へ → 予約済みフレームもキャンセルされる
    loop.invalidate();
    loop.setPaused(true);
    expect(loop.isScheduled()).toBe(false);
    flushFrame();
    expect(draw).toHaveBeenCalledTimes(1);

    // 一時停止中の invalidate は描画しない (dirty だけ積む)
    loop.invalidate();
    flushFrame();
    expect(draw).toHaveBeenCalledTimes(1);

    // viewport 内へ → 停止中の変更を反映するため 1 フレーム描画される
    loop.setPaused(false);
    expect(loop.isScheduled()).toBe(true);
    flushFrame();
    expect(draw).toHaveBeenCalledTimes(2);
    expect(loop.isScheduled()).toBe(false);
  });

  it("停止中に invalidate が無くても、再開時は必ず 1 フレーム描画する", () => {
    // setPaused(false) 自身が dirty を立てることの検証。
    // (停止前後の invalidate に頼ると、再開時描画の保証本体が
    //  テストされないまま通ってしまう)
    const draw = vi.fn();
    const loop = createRenderLoop({ draw });
    loop.invalidate();
    flushFrame();
    expect(draw).toHaveBeenCalledTimes(1);
    expect(loop.isScheduled()).toBe(false);

    // dirty が消化済みの静止状態で viewport 外 → 内
    loop.setPaused(true);
    loop.setPaused(false);
    expect(loop.isScheduled()).toBe(true);
    flushFrame();
    expect(draw).toHaveBeenCalledTimes(2);
    expect(loop.isScheduled()).toBe(false);
  });

  it("一時停止中は継続駆動 (フライモード) でもフレームを予約しない", () => {
    const draw = vi.fn();
    const loop = createRenderLoop({ draw, isContinuous: () => true });
    loop.invalidate();
    flushFrame();
    expect(draw).toHaveBeenCalledTimes(1);
    expect(loop.isScheduled()).toBe(true);

    loop.setPaused(true);
    expect(loop.isScheduled()).toBe(false);
    flushFrame();
    expect(draw).toHaveBeenCalledTimes(1);

    // 再開すると継続駆動に戻る
    loop.setPaused(false);
    flushFrame();
    flushFrame();
    expect(draw).toHaveBeenCalledTimes(3);
    expect(loop.isScheduled()).toBe(true);
  });

  it("draw 中の invalidate (capture 等) は次フレームの描画になる", () => {
    let requeue = false;
    const loop = createRenderLoop({
      draw: () => {
        draws++;
        if (requeue) {
          requeue = false;
          loop.invalidate();
        }
      },
    });
    let draws = 0;

    requeue = true;
    loop.invalidate();
    flushFrame();
    expect(draws).toBe(1);
    expect(loop.isScheduled()).toBe(true);
    flushFrame();
    expect(draws).toBe(2);
    expect(loop.isScheduled()).toBe(false);
  });

  it("dispose 後は invalidate / setPaused を無視する", () => {
    const draw = vi.fn();
    const loop = createRenderLoop({ draw });
    loop.invalidate();
    loop.dispose();
    expect(loop.isScheduled()).toBe(false);
    flushFrame();
    expect(draw).not.toHaveBeenCalled();

    loop.invalidate();
    loop.setPaused(false);
    flushFrame();
    expect(draw).not.toHaveBeenCalled();
  });
});
