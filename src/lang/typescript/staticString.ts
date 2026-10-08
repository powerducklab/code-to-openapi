import type {TsAnalysis} from './index.js';

/** Evaluate literal paths and immutable string composition without executing code.
 * Runtime configuration, mutable bindings and arbitrary function calls stay opaque. */
export function staticString(analysis: TsAnalysis, node: any, seen = new Set<any>()): string | undefined {
  const {ts, checker} = analysis;
  if (!node || seen.size >= 24 || seen.has(node)) return;
  const next = new Set(seen).add(node);
  const read = (value: any) => staticString(analysis, value, next);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return read(node.expression);
  if (ts.isIdentifier(node)) {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const decl = symbol?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && (decl.parent.flags & ts.NodeFlags.Const) && analysis.isProjectFile(decl.getSourceFile().fileName)) return read(decl.initializer);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = read(node.left), right = read(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let result = node.head.text;
    for (const span of node.templateSpans) {
      const value = ts.isNumericLiteral(span.expression) ? span.expression.text : read(span.expression);
      if (value === undefined) return;
      result += value + span.literal.text;
    }
    return result;
  }
}
