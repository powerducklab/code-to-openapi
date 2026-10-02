/**
 * Django REST Framework framework pack (python).
 *
 * Scaffold for the 0.9.0 framework expansion; the owning shard replaces this
 * stub with route, parameter, request-body and response extraction. Honest
 * gaps use the shared GapCode set; fields are never fabricated.
 */

import type {
  ExtractionResult,
  FrameworkPack,
  ScanContext,
} from "../core/types.js";
import type { PythonAnalysis } from "../lang/python/index.js";

function emptyResult(): ExtractionResult {
  return {
    routes: [],
    unresolved: [],
    components: [],
    securitySchemes: [],
    servers: [],
  };
}

export const drfPack: FrameworkPack<PythonAnalysis> = {
  id: "drf",
  language: "python",
  dependencyHints: ["djangorestframework"],

  applies(_ctx: ScanContext): boolean {
    return false;
  },

  extract(_analysis: PythonAnalysis, _ctx: ScanContext): ExtractionResult {
    return emptyResult();
  },
};
