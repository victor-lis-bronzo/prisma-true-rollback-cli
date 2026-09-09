/**
 * Environment Guard (Requirements 2.1, 2.2).
 *
 * Determines whether a rollback invocation is permitted by classifying the
 * environment and then evaluating that classification against the override
 * flag. This is a pure, side-effect-free component: it makes no changes to the
 * Database or file system and performs no I/O. The orchestrator acts on the
 * returned {@link GuardDecision}.
 *
 * Classification rules (design.md, "Environment Guard"):
 * - `NODE_ENV === 'production'` OR a production connection-target designation
 *   ⇒ `'production'`.
 * - missing/unrecognized `NODE_ENV` AND an absent connection-target designation
 *   ⇒ `'ambiguous'`.
 * - otherwise ⇒ `'development'`.
 *
 * Evaluation rules:
 * - `'production'`  ⇒ block regardless of the override flag (R2.1), non-zero exit.
 * - `'ambiguous'`   ⇒ block unless the override flag is supplied (R2.2), non-zero
 *                     exit; with override ⇒ allow.
 * - `'development'` ⇒ allow.
 */

import type { EnvClassification, GuardDecision } from '../models/types.js';

/** Non-zero exit code used when the guard blocks the operation (R2.1, R2.2). */
const GUARD_BLOCK_EXIT_CODE = 1;

/**
 * The set of `NODE_ENV` values the guard recognizes as an explicit,
 * non-production environment. Any other value (including undefined, empty, or
 * whitespace-only) is treated as unrecognized for classification purposes.
 */
const RECOGNIZED_NON_PRODUCTION_NODE_ENVS: ReadonlySet<string> = new Set([
  'development',
  'test',
]);

export class EnvironmentGuard {
  /**
   * Classify the invocation environment from the resolved `NODE_ENV` value and
   * the optional connection-target designation (R2.1, R2.2).
   */
  classify(input: {
    nodeEnv: string | undefined;
    connectionTargetDesignation: 'production' | 'development' | undefined;
  }): EnvClassification {
    const normalizedNodeEnv = input.nodeEnv?.trim().toLowerCase();
    const { connectionTargetDesignation } = input;

    // A Production_Indicator on either signal forces `production` (R2.1).
    if (
      normalizedNodeEnv === 'production' ||
      connectionTargetDesignation === 'production'
    ) {
      return 'production';
    }

    const hasRecognizedNodeEnv =
      normalizedNodeEnv !== undefined &&
      normalizedNodeEnv.length > 0 &&
      RECOGNIZED_NON_PRODUCTION_NODE_ENVS.has(normalizedNodeEnv);
    const hasDesignation = connectionTargetDesignation !== undefined;

    // Neither signal identifies the environment ⇒ ambiguous (R2.2).
    if (!hasRecognizedNodeEnv && !hasDesignation) {
      return 'ambiguous';
    }

    // At least one signal identifies a non-production environment.
    return 'development';
  }

  /**
   * Evaluate a classification against the override flag into a decision the
   * orchestrator acts on (R2.1, R2.2).
   */
  evaluate(
    classification: EnvClassification,
    overrideFlag: boolean,
  ): GuardDecision {
    switch (classification) {
      case 'production':
        // Blocked regardless of override (R2.1).
        return {
          allow: false,
          reason: 'production',
          exitCode: GUARD_BLOCK_EXIT_CODE,
        };
      case 'ambiguous':
        // Blocked unless an explicit override is supplied (R2.2).
        if (overrideFlag) {
          return { allow: true };
        }
        return {
          allow: false,
          reason: 'ambiguous',
          exitCode: GUARD_BLOCK_EXIT_CODE,
        };
      case 'development':
        return { allow: true };
    }
  }
}
