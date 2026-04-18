/**
 * M6-11: Benchmark tests
 */
import { describe, it, expect } from 'vitest';
import {
  BenchmarkSuite,
  percentile,
  measureIterations,
  formatBenchmarkReport,
  type BenchmarkResult,
  type BenchmarkReport,
  type TimingResult,
} from '@squad/sdk/runtime/benchmarks';

// ============================================================================
// percentile helper
// ============================================================================

describe('percentile', () => {
  it('should return 0 for empty array', () => {
    expect(percentile([], 95)).toBe(0);
  });

  it('should return the only element for single-element array', () => {
    expect(percentile([42], 95)).toBe(42);
  });

  it('should compute p95 for sorted array', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 95)).toBe(95);
  });

  it('should compute p99 for sorted array', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 99)).toBe(99);
  });

  it('should compute p50 (median)', () => {
    const sorted = [1, 2, 3, 4, 5];
    expect(percentile(sorted, 50)).toBe(3);
  });
});

// ============================================================================
// measureIterations
// ============================================================================

describe('measureIterations', () => {
  it('should throw for 0 iterations', async () => {
    await expect(measureIterations(() => {}, 0)).rejects.toThrow('at least 1');
  });

  it('should return stats for 1 iteration', async () => {
    const stats = await measureIterations(() => {}, 1);
    expect(stats.avg).toBeGreaterThanOrEqual(0);
    expect(stats.min).toBeGreaterThanOrEqual(0);
    expect(stats.max).toBeGreaterThanOrEqual(0);
    expect(stats.p95).toBeGreaterThanOrEqual(0);
    expect(stats.p99).toBeGreaterThanOrEqual(0);
    expect(stats.timings).toHaveLength(1);
  });

  it('should return stats for multiple iterations', async () => {
    const stats = await measureIterations(() => {}, 10);
    expect(stats.timings).toHaveLength(10);
    expect(stats.min).toBeLessThanOrEqual(stats.avg);
    expect(stats.max).toBeGreaterThanOrEqual(stats.avg);
  });

  it('should handle async functions', async () => {
    const stats = await measureIterations(
      async () => { await Promise.resolve(); },
      5,
    );
    expect(stats.timings).toHaveLength(5);
  });

  it('should have sorted timings', async () => {
    const stats = await measureIterations(() => {}, 20);
    for (let i = 1; i < stats.timings.length; i++) {
      expect(stats.timings[i]).toBeGreaterThanOrEqual(stats.timings[i - 1]);
    }
  });
});

// ============================================================================
// BenchmarkSuite
// ============================================================================

describe('BenchmarkSuite', () => {
  it('should list built-in benchmarks', () => {
    const suite = new BenchmarkSuite();
    const names = suite.list();
    expect(names).toContain('configLoad');
    expect(names).toContain('charterCompile');
    expect(names).toContain('routing');
    expect(names).toContain('modelSelection');
    expect(names).toContain('exportImport');
  });

  it('should register a custom benchmark', () => {
    const suite = new BenchmarkSuite();
    suite.register('custom', () => {});
    expect(suite.list()).toContain('custom');
  });

  it('should unregister a benchmark', () => {
    const suite = new BenchmarkSuite();
    suite.register('temp', () => {});
    expect(suite.unregister('temp')).toBe(true);
    expect(suite.list()).not.toContain('temp');
  });

  it('should return false when unregistering non-existent benchmark', () => {
    const suite = new BenchmarkSuite();
    expect(suite.unregister('nope')).toBe(false);
  });

  describe('benchmarkConfigLoad', () => {
    it('should return timing results', async () => {
      const suite = new BenchmarkSuite();
      const result: TimingResult = await suite.benchmarkConfigLoad(5);
      expect(result.avg).toBeGreaterThanOrEqual(0);
      expect(result.min).toBeLessThanOrEqual(result.max);
      expect(result.p95).toBeGreaterThanOrEqual(0);
    });
  });

  describe('benchmarkCharterCompile', () => {
    it('should return timing results', async () => {
      const suite = new BenchmarkSuite();
      const result = await suite.benchmarkCharterCompile(5);
      expect(result.avg).toBeGreaterThanOrEqual(0);
    });
  });

  describe('benchmarkRouting', () => {
    it('should return timing results', async () => {
      const suite = new BenchmarkSuite();
      const result = await suite.benchmarkRouting(5);
      expect(result.avg).toBeGreaterThanOrEqual(0);
    });
  });

  describe('benchmarkModelSelection', () => {
    it('should return timing results', async () => {
      const suite = new BenchmarkSuite();
      const result = await suite.benchmarkModelSelection(5);
      expect(result.avg).toBeGreaterThanOrEqual(0);
    });
  });

  describe('benchmarkExportImport', () => {
    it('should return timing results', async () => {
      const suite = new BenchmarkSuite();
      const result = await suite.benchmarkExportImport(5);
      expect(result.avg).toBeGreaterThanOrEqual(0);
    });
  });

  describe('runAll', () => {
    it('should produce a report with all benchmarks', async () => {
      const suite = new BenchmarkSuite();
      const report: BenchmarkReport = await suite.runAll(3);
      expect(report.results).toHaveLength(5);
      expect(report.totalTime).toBeGreaterThan(0);
      expect(report.timestamp).toBeTruthy();
    });

    it('should default to 100 iterations', async () => {
      const suite = new BenchmarkSuite();
      // Only keep a single fast benchmark to keep the test quick
      for (const name of suite.list()) {
        if (name !== 'configLoad') suite.unregister(name);
      }
      const report = await suite.runAll();
      expect(report.results[0].iterations).toBe(100);
    });

    it('should include custom benchmarks', async () => {
      const suite = new BenchmarkSuite();
      // Remove default benchmarks, add a custom one
      for (const name of suite.list()) suite.unregister(name);
      suite.register('myBench', () => {});
      const report = await suite.runAll(2);
      expect(report.results).toHaveLength(1);
      expect(report.results[0].name).toBe('myBench');
    });

    it('should include p99 in results', async () => {
      const suite = new BenchmarkSuite();
      for (const name of suite.list()) {
        if (name !== 'routing') suite.unregister(name);
      }
      const report = await suite.runAll(10);
      expect(report.results[0].p99).toBeGreaterThanOrEqual(0);
    });
  });
});

// ============================================================================
// formatBenchmarkReport
// ============================================================================

describe('formatBenchmarkReport', () => {
  it('should return a message for empty results', () => {
    expect(formatBenchmarkReport([])).toContain('No benchmark results');
  });

  it('should format a single result', () => {
    const results: BenchmarkResult[] = [
      { name: 'test', iterations: 10, avg: 1.234, min: 0.5, max: 2.0, p95: 1.9, p99: 2.0 },
    ];
    const output = formatBenchmarkReport(results);
    expect(output).toContain('test');
    expect(output).toContain('10');
    expect(output).toContain('1.234');
    expect(output).toContain('Avg (ms)');
    expect(output).toContain('P99 (ms)');
  });

  it('should format multiple results', () => {
    const results: BenchmarkResult[] = [
      { name: 'a', iterations: 5, avg: 1.0, min: 0.5, max: 1.5, p95: 1.4, p99: 1.5 },
      { name: 'b', iterations: 5, avg: 2.0, min: 1.0, max: 3.0, p95: 2.8, p99: 3.0 },
    ];
    const output = formatBenchmarkReport(results);
    expect(output).toContain('a');
    expect(output).toContain('b');
  });

  it('should include separator lines', () => {
    const results: BenchmarkResult[] = [
      { name: 'x', iterations: 1, avg: 0, min: 0, max: 0, p95: 0, p99: 0 },
    ];
    const output = formatBenchmarkReport(results);
    expect(output).toContain('─');
  });
});
