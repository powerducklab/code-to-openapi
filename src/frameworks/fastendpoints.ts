/**
 * FastEndpoints framework pack (csharp).
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
import type { CSharpAnalysis } from "../lang/csharp/index.js";

function emptyResult(): ExtractionResult {
  return {
    routes: [],
    unresolved: [],
    components: [],
    securitySchemes: [],
    servers: [],
  };
}

export const fastendpointsPack: FrameworkPack<CSharpAnalysis> = {
  id: "fastendpoints",
  language: "csharp",
  dependencyHints: ["FastEndpoints"],

  applies(_ctx: ScanContext): boolean {
    return false;
  },

  extract(_analysis: CSharpAnalysis, _ctx: ScanContext): ExtractionResult {
    return emptyResult();
  },
};
