/**
 * JAX-RS (Jersey, Quarkus RESTEasy Reactive, Dropwizard) framework pack (java).
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

export const jaxrsPack: FrameworkPack<JavaAnalysis> = {
  id: "jaxrs",
  language: "java",
  dependencyHints: ["jakarta.ws.rs-api", "javax.ws.rs-api", "jersey", "quarkus-resteasy-reactive", "dropwizard-core"],

  applies(_ctx: ScanContext): boolean {
    return false;
  },

  extract(_analysis: JavaAnalysis, _ctx: ScanContext): ExtractionResult {
    return emptyResult();
  },
};
