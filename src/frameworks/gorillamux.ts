/**
 * gorilla/mux framework pack (go).
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
import type { GoAnalysis } from "../lang/go/index.js";

function emptyResult(): ExtractionResult {
  return {
    routes: [],
    unresolved: [],
    components: [],
    securitySchemes: [],
    servers: [],
  };
}

export const gorillamuxPack: FrameworkPack<GoAnalysis> = {
  id: "gorillamux",
  language: "go",
  dependencyHints: ["github.com/gorilla/mux"],

  applies(_ctx: ScanContext): boolean {
    return false;
  },

  extract(_analysis: GoAnalysis, _ctx: ScanContext): ExtractionResult {
    return emptyResult();
  },
};
