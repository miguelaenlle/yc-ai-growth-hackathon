export function summarize_easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export function summarize_lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
