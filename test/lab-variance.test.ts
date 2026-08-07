/**
 * The study's arithmetic, which is the one part that fails silently.
 *
 * A wrong mean still renders. A noise floor computed by averaging standard
 * deviations instead of variances is smaller than the truth, which makes every
 * effect look more real than it is — and nothing about the report would look
 * wrong. So each rule is asserted against numbers worked out by hand.
 */

import { describe, it, expect } from 'vitest';

import {
  axesDisagree,
  cells,
  describe as summarise,
  harnessContrasts,
  modelSpread,
  noiseFloor,
  type RunObservation,
} from '../packages/squad-lab/src/variance.js';

const run = (
  task: string,
  model: string,
  harness: string,
  axes: Record<string, number | null>,
  extra: Partial<RunObservation> = {},
): RunObservation => ({
  task,
  model,
  harness,
  variantId: `${model}-${harness}`,
  axes,
  tokensIn: 1000,
  tokensOut: 100,
  costMicroUsd: 50_000,
  toolCalls: 10,
  toolFailures: 0,
  durationMs: 60_000,
  ...extra,
});

describe('describe', () => {
  it('is null for nothing measured', () => {
    expect(summarise([])).toBeNull();
    expect(summarise([null, undefined])).toBeNull();
  });

  it('drops unscored rather than counting them as zero', () => {
    // The distinction the whole summary view is built on. Treating `null` as 0
    // would report this cell at 0.5.
    const stat = summarise([1, null, 1]);
    expect(stat?.n).toBe(2);
    expect(stat?.mean).toBe(1);
  });

  it('has no sd for a single observation', () => {
    expect(summarise([0.5])?.sd).toBeNull();
  });

  it('uses the sample sd, not the population one', () => {
    // [2,4,4,4,5,5,7,9]: population sd is 2, sample sd is ~2.138.
    const stat = summarise([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(stat?.mean).toBe(5);
    expect(stat?.sd).toBeCloseTo(2.13809, 4);
  });

  it('reports the range', () => {
    const stat = summarise([0.2, 0.9, 0.5]);
    expect(stat?.min).toBe(0.2);
    expect(stat?.max).toBe(0.9);
  });
});

describe('cells', () => {
  const observations = [
    run('csv', 'haiku', 'ai-sdk', { acceptance: 1 }),
    run('csv', 'haiku', 'ai-sdk', { acceptance: 0.8 }),
    run('csv', 'haiku', 'squad-native', { acceptance: 0.6 }),
  ];

  it('groups by task, model and harness together', () => {
    const cs = cells(observations, ['acceptance']);
    expect(cs).toHaveLength(2);
    expect(cs.find((c) => c.harness === 'ai-sdk')?.n).toBe(2);
  });

  it('describes each axis within a cell', () => {
    const cs = cells(observations, ['acceptance']);
    const aiSdk = cs.find((c) => c.harness === 'ai-sdk')!;
    expect(aiSdk.byAxis['acceptance']?.mean).toBeCloseTo(0.9, 10);
  });

  it('treats an unpriced run as unpriced and not as free', () => {
    const cs = cells(
      [
        run('csv', 'flash', 'ai-sdk', { acceptance: 1 }, { costMicroUsd: null }),
        run('csv', 'flash', 'ai-sdk', { acceptance: 1 }, { costMicroUsd: null }),
      ],
      ['acceptance'],
    );
    // Not `0`, which would make the unpriced vendor the cheapest one.
    expect(cs[0]!.costMicroUsd).toBeNull();
  });

  it('computes a tool failure rate over calls, not over runs', () => {
    const cs = cells(
      [
        run('csv', 'haiku', 'ai-sdk', {}, { toolCalls: 10, toolFailures: 1 }),
        run('csv', 'haiku', 'ai-sdk', {}, { toolCalls: 30, toolFailures: 3 }),
      ],
      [],
    );
    expect(cs[0]!.toolFailureRate).toBeCloseTo(0.1, 10);
  });
});

describe('noiseFloor', () => {
  it('pools variances rather than averaging standard deviations', () => {
    // Cell a is [0.5, 0.5] — sd 0, variance 0.
    // Cell b is [0, 1]     — sample sd sqrt(0.5) = 0.7071, variance 0.5.
    //
    // Pooling variances:  sqrt((0 + 0.5) / 2) = 0.5
    // Averaging sds:      (0 + 0.7071) / 2    = 0.3536
    //
    // The first is correct. The second understates the floor by a third, and
    // a floor that is too small makes every effect measured against it look
    // more real than it is — while the report still renders perfectly.
    const cs = cells(
      [
        run('t', 'a', 'ai-sdk', { acc: 0.5 }),
        run('t', 'a', 'ai-sdk', { acc: 0.5 }),
        run('t', 'b', 'ai-sdk', { acc: 0 }),
        run('t', 'b', 'ai-sdk', { acc: 1 }),
      ],
      ['acc'],
    );
    const floor = noiseFloor(cs, 'acc')!;
    expect(floor.cells).toBe(2);
    expect(floor.sd).toBeCloseTo(0.5, 10);
    expect(floor.sd).toBeGreaterThan((0 + Math.sqrt(0.5)) / 2);
  });

  it('ignores cells that cannot have an sd', () => {
    const cs = cells([run('t', 'a', 'ai-sdk', { acc: 1 })], ['acc']);
    expect(noiseFloor(cs, 'acc')).toBeNull();
  });
});

describe('harnessContrasts', () => {
  const cs = cells(
    [
      run('csv', 'haiku', 'squad-native', { acc: 0.4 }),
      run('csv', 'haiku', 'squad-native', { acc: 0.6 }),
      run('csv', 'haiku', 'ai-sdk', { acc: 0.9 }),
      run('csv', 'haiku', 'ai-sdk', { acc: 0.9 }),
    ],
    ['acc'],
  );

  it('reports ai-sdk minus squad-native, holding the model fixed', () => {
    const [contrast] = harnessContrasts(cs, 'acc');
    expect(contrast!.holding).toBe('haiku');
    expect(contrast!.meanA).toBeCloseTo(0.5, 10);
    expect(contrast!.meanB).toBeCloseTo(0.9, 10);
    expect(contrast!.delta).toBeCloseTo(0.4, 10);
  });

  it('expresses the delta in units of the noise floor', () => {
    // Pooled sd over sd(0.4,0.6)=0.1414 and sd(0.9,0.9)=0 → sqrt(0.02/2)=0.1.
    const [contrast] = harnessContrasts(cs, 'acc');
    expect(contrast!.vsNoise).toBeCloseTo(4, 5);
  });

  it('skips a model that was not run under both arms', () => {
    const lonely = cells([run('csv', 'sonnet', 'ai-sdk', { acc: 1 })], ['acc']);
    expect(harnessContrasts(lonely, 'acc')).toEqual([]);
  });
});

describe('modelSpread', () => {
  it('orders models and reports best minus worst', () => {
    const cs = cells(
      [
        run('csv', 'sonnet', 'ai-sdk', { acc: 1 }),
        run('csv', 'haiku', 'ai-sdk', { acc: 0.6 }),
        run('csv', 'flash', 'ai-sdk', { acc: 0.2 }),
      ],
      ['acc'],
    );
    const [spread] = modelSpread(cs, 'acc');
    expect(spread!.byModel.map((m) => m.model)).toEqual(['sonnet', 'haiku', 'flash']);
    expect(spread!.range).toBeCloseTo(0.8, 10);
  });

  it('keeps each harness separate', () => {
    const cs = cells(
      [
        run('csv', 'a', 'ai-sdk', { acc: 1 }),
        run('csv', 'b', 'ai-sdk', { acc: 0.5 }),
        run('csv', 'a', 'squad-native', { acc: 0.3 }),
        run('csv', 'b', 'squad-native', { acc: 0.2 }),
      ],
      ['acc'],
    );
    expect(modelSpread(cs, 'acc')).toHaveLength(2);
  });
});

describe('axesDisagree', () => {
  it('is false when both axes order the cells the same way', () => {
    const cs = cells(
      [
        run('csv', 'a', 'ai-sdk', { acc: 1, edge: 0.9 }),
        run('csv', 'b', 'ai-sdk', { acc: 0.5, edge: 0.4 }),
      ],
      ['acc', 'edge'],
    );
    expect(axesDisagree(cs, 'acc', 'edge')).toBe(false);
  });

  it('is true when a cell that leads on one axis trails on the other', () => {
    // The m8 result, asked of cell means instead of single runs.
    const cs = cells(
      [
        run('csv', 'a', 'ai-sdk', { acc: 1, edge: 0.2 }),
        run('csv', 'b', 'ai-sdk', { acc: 0.5, edge: 0.9 }),
      ],
      ['acc', 'edge'],
    );
    expect(axesDisagree(cs, 'acc', 'edge')).toBe(true);
  });

  it('needs at least two comparable cells to disagree about anything', () => {
    const cs = cells([run('csv', 'a', 'ai-sdk', { acc: 1, edge: 0 })], ['acc', 'edge']);
    expect(axesDisagree(cs, 'acc', 'edge')).toBe(false);
  });
});
