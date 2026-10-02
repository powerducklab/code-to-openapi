/**
 * actix-web framework pack (rust).
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
import type { RustAnalysis } from "../lang/rust/index.js";

function emptyResult(): ExtractionResult {
  return {
    routes: [],
    unresolved: [],
    components: [],
    securitySchemes: [],
    servers: [],
  };
}

export const actixPack: FrameworkPack<RustAnalysis> = {
  id: "actix",
  language: "rust",
  dependencyHints: ["actix-web"],

  applies(_ctx: ScanContext): boolean {
    return false;
  },

  extract(_analysis: RustAnalysis, _ctx: ScanContext): ExtractionResult {
    return emptyResult();
  },
};
