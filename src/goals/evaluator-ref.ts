/**
 * Lazy reference to GoalEvaluator.
 *
 * Avoids circular dependency between tools.ts → evaluator.ts → store.ts → index.ts → tools.ts.
 * Set from index.ts after construction, consumed by tools.ts for on-demand evaluation.
 */

import type { GoalEvaluator } from './evaluator.js';

let _evaluator: GoalEvaluator | null = null;

export function setGoalEvaluator(evaluator: GoalEvaluator): void {
  _evaluator = evaluator;
}

export function getGoalEvaluator(): GoalEvaluator | null {
  return _evaluator;
}
