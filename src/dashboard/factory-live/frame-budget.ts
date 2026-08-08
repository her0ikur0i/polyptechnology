export type FrameRate = 30 | 15 | 5;
export class FrameBudget {
  private samples: number[] = [];
  private stable = 0;
  constructor(private rate: FrameRate = 30) {}
  record(durationMs: number): FrameRate {
    this.samples.push(Math.max(0, durationMs));
    if (this.samples.length > 30) this.samples.shift();
    const average =
      this.samples.reduce((sum, value) => sum + value, 0) / this.samples.length;
    if (this.samples.length === 30 && average > 24) {
      this.rate = this.rate === 30 ? 15 : 5;
      this.samples = [];
      this.stable = 0;
    } else if (this.samples.length === 30 && average < 10) {
      this.stable++;
      this.samples = [];
      if (this.stable >= 3) {
        this.rate = this.rate === 5 ? 15 : 30;
        this.stable = 0;
      }
    } else if (this.samples.length === 30) {
      this.samples = [];
      this.stable = 0;
    }
    return this.rate;
  }
  current() {
    return this.rate;
  }
  intervalMs() {
    return 1000 / this.rate;
  }
}
