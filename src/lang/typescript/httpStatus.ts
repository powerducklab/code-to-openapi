/**
 * Standard HTTP status constant names shared by the `http-status-codes`
 * package, Node's `http` module and typical app-level StatusCodes enums.
 * Their numeric meaning is fixed by RFC 9110, so a computed object key such
 * as `[StatusCodes.OK]` resolves deterministically without cross-file
 * analysis.
 */
export const STATUS_NAME_MAP: Record<string, string> = {
  CONTINUE: "100",
  OK: "200",
  CREATED: "201",
  ACCEPTED: "202",
  NO_CONTENT: "204",
  MOVED_PERMANENTLY: "301",
  FOUND: "302",
  NOT_MODIFIED: "304",
  BAD_REQUEST: "400",
  UNAUTHORIZED: "401",
  FORBIDDEN: "403",
  NOT_FOUND: "404",
  METHOD_NOT_ALLOWED: "405",
  CONFLICT: "409",
  GONE: "410",
  UNPROCESSABLE_ENTITY: "422",
  UNPROCESSABLE_CONTENT: "422",
  TOO_MANY_REQUESTS: "429",
  INTERNAL_SERVER_ERROR: "500",
  NOT_IMPLEMENTED: "501",
  BAD_GATEWAY: "502",
  SERVICE_UNAVAILABLE: "503",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolveStatusName(ts: any, nameNode: any): string | null {
  if (ts.isNumericLiteral(nameNode)) return nameNode.text;
  if (ts.isStringLiteralLike(nameNode) && /^\d{3}$/.test(nameNode.text)) {
    return nameNode.text;
  }
  // Computed property: [200], [StatusCodes.OK], [HttpStatusCode.CREATED].
  if (nameNode.kind === ts.SyntaxKind.ComputedPropertyName) {
    const expr = nameNode.expression;
    if (!expr) return null;
    if (ts.isNumericLiteral(expr)) return expr.text;
    if (ts.isPropertyAccessExpression(expr)) {
      return STATUS_NAME_MAP[expr.name.text] ?? null;
    }
  }
  return null;
}
