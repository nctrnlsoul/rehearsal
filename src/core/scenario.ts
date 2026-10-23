import { z } from "zod";
import { assertAllowedEventTarget } from "./eventTarget";
import { currencyExponent, toMinor } from "./money";
import { topologicalOrder } from "./plan";

/**
 * The scenario schema. Nothing runs unless it passes this, so every rule the
 * engine depends on is enforced here rather than discovered at step 14 of a run
 * that has already moved money.
 */

export const MAX_STEPS = 60;

export const STEP_KINDS = [
  "card_order",
  "refund",
  "payout_batch",
  "invoice_create",
  "invoice_send",
  "invoice_record_payment",
  "invoice_cancel",
  "open_dispute",
] as const;

export type StepKind = (typeof STEP_KINDS)[number];

const stepId = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,39}$/,
    "step id must be 1 to 40 characters of lower-case letters, digits, dash or underscore",
  );

/**
 * Amounts are decimal STRINGS. A JSON number cannot represent 0.10 exactly, and
 * a scenario that silently loses a cent is worse than one that refuses to load.
 */
const amount = z
  .string({
    invalid_type_error:
      'amount must be a decimal string like "42.00", never a number: a float cannot hold cents exactly',
  })
  .regex(/^\d+(\.\d+)?$/, 'amount must be an unsigned decimal string like "42.00"');

const baseStep = {
  id: stepId,
  needs: z.array(stepId).max(MAX_STEPS).default([]),
  label: z.string().min(1).max(120).optional(),
};

const cardOrderStep = z.object({ ...baseStep, kind: z.literal("card_order"), amount });

const refundStep = z.object({
  ...baseStep,
  kind: z.literal("refund"),
  from: stepId,
  mode: z.enum(["full", "partial"]),
  /** Basis points, so a partial refund never involves a float. */
  basisPoints: z.number().int().min(1).max(9999).optional(),
});

const payoutItem = z.object({
  amount,
  /** True pays an address with no PayPal account, producing UNCLAIMED. */
  unclaimed: z.boolean().default(false),
  note: z.string().max(200).optional(),
});

const payoutBatchStep = z.object({
  ...baseStep,
  kind: z.literal("payout_batch"),
  items: z.array(payoutItem).min(1).max(10),
});

const invoiceCreateStep = z.object({
  ...baseStep,
  kind: z.literal("invoice_create"),
  amount,
  itemName: z.string().min(1).max(120).optional(),
  /** Negative puts the due date in the past, which is how an overdue invoice is made. */
  dueInDays: z.number().int().min(-365).max(365).optional(),
});

const invoiceSendStep = z.object({ ...baseStep, kind: z.literal("invoice_send"), from: stepId });

const invoiceRecordPaymentStep = z.object({
  ...baseStep,
  kind: z.literal("invoice_record_payment"),
  from: stepId,
  amount: amount.optional(),
});

const invoiceCancelStep = z.object({ ...baseStep, kind: z.literal("invoice_cancel"), from: stepId });

const openDisputeStep = z.object({
  ...baseStep,
  kind: z.literal("open_dispute"),
  reason: z
    .enum(["MERCHANDISE_OR_SERVICE_NOT_RECEIVED", "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED"])
    .default("MERCHANDISE_OR_SERVICE_NOT_RECEIVED"),
});

const stepSchema = z.discriminatedUnion("kind", [
  cardOrderStep,
  refundStep,
  payoutBatchStep,
  invoiceCreateStep,
  invoiceSendStep,
  invoiceRecordPaymentStep,
  invoiceCancelStep,
  openDisputeStep,
]);

export type Step = z.infer<typeof stepSchema>;

const profileSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(400).optional(),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/, "country must be a 2 letter uppercase code")
    .default("US"),
});

const webhookSchema = z.object({
  target: z.string().min(1),
  eventTypes: z.array(z.string().min(1)).min(1).default(["*"]),
});

const scenarioObject = z.object({
  version: z.literal(1),
  name: z.string().min(1).max(80),
  profile: profileSchema,
  currency: z.string().regex(/^[A-Z]{3}$/, "currency must be a 3 letter uppercase code"),
  webhook: webhookSchema.optional(),
  steps: z
    .array(stepSchema)
    .min(1, "a scenario needs at least one step")
    .max(MAX_STEPS, `a scenario may not exceed ${MAX_STEPS} steps`),
});

export type Scenario = z.infer<typeof scenarioObject>;

/** Which step kind each `from` reference must point at. */
const FROM_MUST_BE: Partial<Record<StepKind, StepKind>> = {
  refund: "card_order",
  invoice_send: "invoice_create",
  invoice_record_payment: "invoice_create",
  invoice_cancel: "invoice_create",
};

export type ScenarioOptions = {
  /** Origins a scenario may aim real PayPal events at. Empty permits none. */
  readonly allowedEventOrigins: readonly string[];
};

export function scenarioSchema(options: ScenarioOptions) {
  return scenarioObject.superRefine((scenario, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

    let exponentKnown = true;
    try {
      currencyExponent(scenario.currency);
    } catch (e) {
      exponentKnown = false;
      issue(["currency"], (e as Error).message);
    }

    const checkAmount = (value: string, path: (string | number)[]) => {
      if (!exponentKnown) return;
      try {
        toMinor(value, scenario.currency);
      } catch (e) {
        issue(path, (e as Error).message);
      }
    };

    scenario.steps.forEach((step, i) => {
      switch (step.kind) {
        case "card_order":
        case "invoice_create":
          checkAmount(step.amount, ["steps", i, "amount"]);
          break;
        case "invoice_record_payment":
          if (step.amount !== undefined) checkAmount(step.amount, ["steps", i, "amount"]);
          break;
        case "payout_batch":
          step.items.forEach((item, j) =>
            checkAmount(item.amount, ["steps", i, "items", j, "amount"]),
          );
          break;
        default:
          break;
      }
    });

    const plan = topologicalOrder(scenario.steps.map((s) => ({ id: s.id, needs: s.needs })));
    if (!plan.ok) {
      for (const e of plan.errors) issue(["steps"], e.message);
    }

    const byId = new Map(scenario.steps.map((s) => [s.id, s]));
    scenario.steps.forEach((step, i) => {
      const required = FROM_MUST_BE[step.kind];
      if (required === undefined) return;
      const from = (step as { from: string }).from;
      const target = byId.get(from);
      if (target === undefined) {
        issue(["steps", i, "from"], `${step.kind} step ${step.id} references unknown step ${from}`);
        return;
      }
      if (target.kind !== required) {
        issue(
          ["steps", i, "from"],
          `${step.kind} step ${step.id} must reference a ${required} step, but ${from} is a ${target.kind}`,
        );
      }
      if (!step.needs.includes(from)) {
        issue(
          ["steps", i, "needs"],
          `${step.kind} step ${step.id} references ${from} but does not list it in needs, so the run order would be implicit`,
        );
      }
    });

    scenario.steps.forEach((step, i) => {
      if (step.kind !== "refund") return;
      if (step.mode === "partial" && step.basisPoints === undefined) {
        issue(["steps", i, "basisPoints"], "a partial refund must state basisPoints");
      }
      if (step.mode === "full" && step.basisPoints !== undefined) {
        issue(["steps", i, "basisPoints"], "a full refund must not state basisPoints");
      }
    });

    if (scenario.webhook !== undefined) {
      try {
        assertAllowedEventTarget(scenario.webhook.target, options.allowedEventOrigins);
      } catch (e) {
        issue(["webhook", "target"], (e as Error).message);
      }
    }
  });
}

export type ValidationResult =
  | { readonly ok: true; readonly scenario: Scenario }
  | { readonly ok: false; readonly errors: string[] };

export function validateScenario(input: unknown, options: ScenarioOptions): ValidationResult {
  const parsed = scenarioSchema(options).safeParse(input);
  if (parsed.success) return { ok: true, scenario: parsed.data };
  const errors = parsed.error.issues.map(
    (i) => `${i.path.length === 0 ? "(root)" : i.path.join(".")}: ${i.message}`,
  );
  return { ok: false, errors: [...new Set(errors)] };
}
