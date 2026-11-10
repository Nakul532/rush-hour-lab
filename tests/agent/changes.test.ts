import { describe, expect, it } from 'vitest';
import { addStaff, applyChanges, ChangeError, describeChange, parseChanges, simplifyChanges } from '../../src/agent/changes';
import { constraintViolations, DEFAULT_COSTS, planCost } from '../../src/agent/plan';
import { syntheticCafe } from './fixtures';

describe('change menu', () => {
  const cafe = syntheticCafe();

  it('adds staff for part of the rush only', () => {
    expect(addStaff(1, 1, 30, 60)).toEqual([
      { fromMin: 0, servers: 1 },
      { fromMin: 30, servers: 2 },
      { fromMin: 60, servers: 1 },
    ]);
  });

  it('describes changes in clock time when the rush start is known', () => {
    const [c] = parseChanges([{ kind: 'staff', station: 'barista', delta: 1, fromMin: 30, toMin: 90 }], cafe);
    expect(describeChange(c, cafe.startsAt)).toBe('Add 1 barista staff from 08:00 to 09:00');
  });

  it.each([
    [{ kind: 'staff', station: 'roaster', delta: 1 }, /Unknown station/],
    [{ kind: 'staff', station: 'barista', delta: 0 }, /delta/],
    [{ kind: 'staff', station: 'handoff', delta: 1 }, /no dedicated handoff/],
    [{ kind: 'teleport' }, /Unknown change kind/],
    [{ kind: 'grabGo', shareOfDrinks: 2 }, /shareOfDrinks/],
    [{ kind: 'staff', station: 'barista', delta: 1, fromMin: 50, toMin: 20 }, /toMin/],
  ])('rejects %j', (raw, msg) => {
    expect(() => parseChanges([raw], cafe)).toThrow(msg);
  });

  it('rejects a plan that leaves a station with no staff (orders would never be served)', () => {
    expect(() =>
      parseChanges([{ kind: 'staff', station: 'barista', delta: 1 }, { kind: 'staff', station: 'kitchen', delta: -1 }], cafe),
    ).toThrow(ChangeError);
  });

  it('lets later changes build on earlier ones', () => {
    const changes = parseChanges([{ kind: 'dedicatedHandoff', staff: 1 }, { kind: 'staff', station: 'handoff', delta: 1 }], cafe);
    expect(applyChanges(cafe, changes).staff.handoff).toEqual([{ fromMin: 0, servers: 2 }]);
  });

  it('simplifies plans whose staff changes cancel out', () => {
    expect(
      simplifyChanges([
        { kind: 'staff', station: 'barista', delta: 1 },
        { kind: 'staff', station: 'barista', delta: -1 },
        { kind: 'prepMode', mode: 'sequential' },
      ]),
    ).toEqual([{ kind: 'prepMode', mode: 'sequential' }]);
  });

  it('never changes the original café', () => {
    const before = structuredClone(cafe);
    applyChanges(cafe, [{ kind: 'staff', station: 'barista', delta: 2 }, { kind: 'grabGo', shareOfDrinks: 0.5 }]);
    expect(cafe).toEqual(before);
  });
});

describe('constraints and costs (default costs are ASSUMPTIONS)', () => {
  const cafe = syntheticCafe();

  it('no new hires: adding a person is blocked, moving one is allowed', () => {
    const add = [{ kind: 'staff' as const, station: 'barista' as const, delta: 1 }];
    const move = [{ kind: 'staff' as const, station: 'cashier' as const, delta: -1 }, { kind: 'staff' as const, station: 'barista' as const, delta: 1 }];
    const twoCashiers = syntheticCafe({ staff: { cashier: 2, barista: 1, kitchen: 1 } });
    expect(constraintViolations(cafe, add, { noNewHires: true }, DEFAULT_COSTS)).toHaveLength(1);
    expect(constraintViolations(twoCashiers, move, { noNewHires: true }, DEFAULT_COSTS)).toEqual([]);
  });

  it('a dedicated handoff person counts as a new hire', () => {
    expect(constraintViolations(cafe, [{ kind: 'dedicatedHandoff', staff: 1 }], { noNewHires: true }, DEFAULT_COSTS)).toHaveLength(1);
  });

  it('max changes', () => {
    const plan = [{ kind: 'prepMode' as const, mode: 'sequential' as const }, { kind: 'grabGo' as const, shareOfDrinks: 0.2 }];
    expect(constraintViolations(cafe, plan, { maxChanges: 1 }, DEFAULT_COSTS)[0]).toMatch(/limit is 1/);
  });

  it('cost: an extra barista for the 90-minute rush is 1.5 h × $20 × 22 days = $660', () => {
    expect(planCost(cafe, [{ kind: 'staff', station: 'barista', delta: 1 }], DEFAULT_COSTS)).toBeCloseTo(660, 6);
  });

  it('cost: half-rush staff is charged for the hours added', () => {
    expect(planCost(cafe, [{ kind: 'staff', station: 'barista', delta: 1, fromMin: 30, toMin: 60 }], DEFAULT_COSTS)).toBeCloseTo(220, 6);
  });

  it('budget uses the user-entered cost table', () => {
    const plan = [{ kind: 'grabGo' as const, shareOfDrinks: 0.3 }];
    expect(constraintViolations(cafe, plan, { budgetUsd: 100 }, DEFAULT_COSTS)).toHaveLength(1);
    expect(constraintViolations(cafe, plan, { budgetUsd: 100 }, { ...DEFAULT_COSTS, grabGoSetup: 80 })).toEqual([]);
  });
});
