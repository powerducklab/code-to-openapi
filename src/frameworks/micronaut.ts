/**
 * Micronaut framework pack (java).
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
import type { JavaAnalysis } from "../lang/java/index.js";

function emptyResult(): ExtractionResult {
  return {
    routes: [],
    unresolved: [],
    components: [],
    securitySchemes: [],
    servers: [],
  };
}

export const micronautPack: FrameworkPack<JavaAnalysis> = {
  id: "micronaut",
  language: "java",
  dependencyHints: ["micronaut-http", "micronaut-http-server-netty"],

  applies(_ctx: ScanContext): boolean {
    return false;
  },

  extract(_analysis: JavaAnalysis, _ctx: ScanContext): ExtractionResult {
    return emptyResult();
  },
};
