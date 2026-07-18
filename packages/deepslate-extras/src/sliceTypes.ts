// レイヤースライス (Y 範囲表示) のモード定義。
export type SliceMode = "all" | "single" | "bottom-up" | "top-down";

export const SLICE_MODES: SliceMode[] = ["all", "single", "bottom-up", "top-down"];

export const SLICE_MODE_LABELS: Record<SliceMode, string> = {
  all: "全体",
  single: "1層",
  "bottom-up": "下から",
  "top-down": "上から",
};

/** スライスモードと層から表示する Y の [min, max] (inclusive) を返す。 */
export function getSliceRange(mode: SliceMode, layer: number, maxY: number): [number, number] {
  switch (mode) {
    case "all":
      return [0, maxY];
    case "single":
      return [layer, layer];
    case "bottom-up":
      return [0, layer];
    case "top-down":
      return [layer, maxY];
  }
}
