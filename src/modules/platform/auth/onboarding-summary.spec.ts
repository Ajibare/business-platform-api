import { buildOnboardingSummary, parseCompletedSteps } from './onboarding-summary';

describe('onboarding-summary', () => {
  describe('parseCompletedSteps', () => {
    it('keeps valid, unique, sorted step numbers', () => {
      expect(parseCompletedSteps([3, 1, 3, 9, 0, '2'])).toEqual([1, 2, 3]);
    });

    it('returns an empty list for malformed data', () => {
      expect(parseCompletedSteps(null)).toEqual([]);
      expect(parseCompletedSteps({ step: 1 })).toEqual([]);
    });
  });

  it('points at the first unfinished step and still requires setup', () => {
    const summary = buildOnboardingSummary({
      status: 'IN_PROGRESS',
      currentStep: 2,
      completedSteps: [1],
      completedAt: null,
      hasProfile: true,
      hasStockSettings: false,
      staffCount: 1,
      productCount: 0,
    });

    expect(summary.firstIncompleteStep).toBe(2);
    expect(summary.requiresSetup).toBe(true);
    expect(summary.steps.filter((step) => step.completed).map((step) => step.step)).toEqual([1]);
    expect(summary.checklist.find((item) => item.key === 'invite-staff')?.done).toBe(false);
  });

  it('allows completion with optional steps still open', () => {
    const summary = buildOnboardingSummary({
      status: 'COMPLETED',
      currentStep: 2,
      completedSteps: [1, 2],
      completedAt: new Date('2026-11-16T10:00:00Z'),
      hasProfile: true,
      hasStockSettings: true,
      staffCount: 1,
      productCount: 0,
    });

    expect(summary.requiresSetup).toBe(false);
    expect(summary.firstIncompleteStep).toBe(3);
    expect(summary.allTasksDone).toBe(false);
    expect(summary.completedAt).toBe('2026-11-16T10:00:00.000Z');
  });

  it('reports every task done once staff and products exist', () => {
    const summary = buildOnboardingSummary({
      status: 'COMPLETED',
      currentStep: 4,
      completedSteps: [1, 2, 3, 4],
      completedAt: new Date(),
      hasProfile: true,
      hasStockSettings: true,
      staffCount: 3,
      productCount: 12,
    });

    expect(summary.allTasksDone).toBe(true);
    expect(summary.firstIncompleteStep).toBeNull();
  });

  it('counts a saved step as done even when its optional fields are blank', () => {
    const summary = buildOnboardingSummary({
      status: 'COMPLETED',
      currentStep: 4,
      completedSteps: [1, 2, 3, 4],
      completedAt: new Date(),
      // The owner left the default unit and minimum level blank, which is allowed.
      hasProfile: false,
      hasStockSettings: false,
      staffCount: 1,
      productCount: 0,
    });

    const required = summary.checklist.filter((item) => !item.optional);
    expect(required.every((item) => item.done)).toBe(true);
  });

  it('treats a missing onboarding row as unfinished', () => {
    const summary = buildOnboardingSummary({
      status: null,
      currentStep: null,
      completedSteps: undefined,
      completedAt: null,
      hasProfile: false,
      hasStockSettings: false,
      staffCount: 1,
      productCount: 0,
    });

    expect(summary.status).toBe('IN_PROGRESS');
    expect(summary.currentStep).toBe(1);
    expect(summary.firstIncompleteStep).toBe(1);
  });
});
