/**
 * Symfony framework pack (php).
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
import type { PhpAnalysis } from "../lang/php/index.js";

function emptyResult(): ExtractionResult {
  return {
    routes: [],
    unresolved: [],
    components: [],
    securitySchemes: [],
    servers: [],
  };
}

export const symfonyPack: FrameworkPack<PhpAnalysis> = {
  id: "symfony",
  language: "php",
  dependencyHints: ["symfony/framework-bundle"],

  applies(_ctx: ScanContext): boolean {
    return false;
  },

  extract(_analysis: PhpAnalysis, _ctx: ScanContext): ExtractionResult {
    return emptyResult();
  },
};
