export interface OnboardingStepDefinition {
  step: number;
  key: string;
  title: string;
  description: string;
  optional: boolean;
}

/**
 * The four setup steps in the order the wizard presents them. Steps 3 and 4 are
 * optional: a pharmacy can finish onboarding without inviting staff or adding
 * stock, and the dashboard checklist keeps nudging until they are done.
 */
export const ONBOARDING_STEPS: OnboardingStepDefinition[] = [
  {
    step: 1,
    key: 'pharmacy-profile',
    title: 'Pharmacy profile',
    description: 'Name, outlet profile and time zone.',
    optional: false,
  },
  {
    step: 2,
    key: 'stock-settings',
    title: 'Stock settings',
    description: 'Near-expiry warning window and default units.',
    optional: false,
  },
  {
    step: 3,
    key: 'invite-staff',
    title: 'Invite staff',
    description: 'Add managers and inventory staff to the workspace.',
    optional: true,
  },
  {
    step: 4,
    key: 'add-stock',
    title: 'Add stock',
    description: 'Import a CSV, add products manually, use sample data or start empty.',
    optional: true,
  },
];

export interface OnboardingStepState extends OnboardingStepDefinition {
  completed: boolean;
}

export interface OnboardingChecklistItem {
  key: string;
  label: string;
  done: boolean;
  optional: boolean;
}

export interface OnboardingSummary {
  status: 'IN_PROGRESS' | 'COMPLETED';
  currentStep: number;
  completedSteps: number[];
  firstIncompleteStep: number | null;
  steps: OnboardingStepState[];
  checklist: OnboardingChecklistItem[];
  /** True while the owner should still be routed into the wizard. */
  requiresSetup: boolean;
  /** True when every optional task is done, so the dashboard can hide the checklist. */
  allTasksDone: boolean;
  completedAt: string | null;
}

export function parseCompletedSteps(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry) && entry >= 1 && entry <= ONBOARDING_STEPS.length)
    .filter((entry, index, list) => list.indexOf(entry) === index)
    .sort((a, b) => a - b);
}

export interface OnboardingSummaryInput {
  status: string | null | undefined;
  currentStep: number | null | undefined;
  completedSteps: unknown;
  completedAt: Date | null | undefined;
  hasProfile: boolean;
  hasStockSettings: boolean;
  staffCount: number;
  productCount: number;
}

export function buildOnboardingSummary(input: OnboardingSummaryInput): OnboardingSummary {
  const completedSteps = parseCompletedSteps(input.completedSteps);
  const steps = ONBOARDING_STEPS.map((definition) => ({
    ...definition,
    completed: completedSteps.includes(definition.step),
  }));

  const firstIncomplete = steps.find((step) => !step.completed);
  const status = input.status === 'COMPLETED' ? 'COMPLETED' : 'IN_PROGRESS';
  const stepComplete = (step: number) => completedSteps.includes(step);

  // A step the owner saved counts as done even when its optional fields are
  // blank. Deriving "done" only from the stored values would leave the
  // checklist showing a task the person already finished, forever.
  const checklist: OnboardingChecklistItem[] = [
    {
      key: 'pharmacy-profile',
      label: 'Confirm your pharmacy profile',
      done: stepComplete(1) || input.hasProfile,
      optional: false,
    },
    {
      key: 'stock-settings',
      label: 'Set your near-expiry warning window',
      done: stepComplete(2) || input.hasStockSettings,
      optional: false,
    },
    {
      key: 'invite-staff',
      label: 'Invite your team',
      done: input.staffCount > 1,
      optional: true,
    },
    {
      key: 'add-stock',
      label: 'Add your first products',
      done: input.productCount > 0,
      optional: true,
    },
  ];

  return {
    status,
    currentStep: input.currentStep ?? 1,
    completedSteps,
    firstIncompleteStep: firstIncomplete ? firstIncomplete.step : null,
    steps,
    checklist,
    requiresSetup: status !== 'COMPLETED',
    allTasksDone: checklist.every((item) => item.done),
    completedAt: input.completedAt ? input.completedAt.toISOString() : null,
  };
}
