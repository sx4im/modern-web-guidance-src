/* oxlint-disable max-lines-per-function, max-depth */
import { Node, SyntaxKind, type CallExpression, type JsxAttribute, type SourceFile } from 'ts-morph';
import type { AnalyzerMatch, AnalyzerRule, JsMatcherContext, JsRuleMatcher } from '../schema.ts';
import { getSemanticParent, unwrapExpression } from '../scanners/ast-helpers.ts';

export const IME_SAFE_ENTER_SUBMIT_GUIDE_HASH = '99e3b42fb16a';

// keyCode/which === 13 checks are deliberately absent: the keydown that confirms an IME
// composition reports keyCode 229, so those handlers never fire mid-composition.
const ENTER_CHECK_REGEX =
  // `(?:[\w$]+\.)*` allows the event receiver (`e.key`, `event.code`) between
  // the operator and the property name in the reversed `'Enter' === e.key` form.
  /(?:key\s*===?\s*['"]Enter['"]|['"]Enter['"]\s*===?\s*(?:[\w$]+\.)*key|code\s*===?\s*['"]Enter['"]|['"]Enter['"]\s*===?\s*(?:[\w$]+\.)*code|case\s+['"]Enter['"])/;

const SPACE_OR_BUTTON_KEY_REGEX =
  /\b(?:Space|Spacebar)\b|['"] ['"]|(?:keyCode|which)\s*===?\s*32\b|\b32\s*===?\s*(?:keyCode|which)/;

const WIDGET_NAVIGATION_KEYS_REGEX =
  /\b(?:ArrowUp|ArrowDown|ArrowLeft|ArrowRight|PageUp|PageDown)\b|(?:keyCode|which)\s*===?\s*(?:32|33|34|37|38|39|40)\b|\b(?:32|33|34|37|38|39|40)\s*===?\s*(?:keyCode|which)|\bcase\s+(?:32|33|34|37|38|39|40)\s*:/;

const SYNTHETIC_KEY_EVENT_REGEX =
  /Event\s*\(\s*['"]key(?:press|down|up)['"]\s*\)/i;

const ARIA_BUTTON_ROLES = new Set([
  'button',
  'menuitem',
  'tab',
  'link',
  'switch',
  'checkbox',
  'option',
]);

const TEST_FILE_PATH_REGEX =
  /(?:^|\/)(?:__tests__|tests?|specs?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/i;

/**
 * Checks if a branch contains only event suppression calls (preventDefault, stopPropagation)
 * and control returns, with no submission or action invocations.
 */
function isSuppressOnlyBranch(branchText: string): boolean {
  const stripped = branchText
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')
    .replace(/(?:e|event|evt)\s*\.\s*(?:preventDefault|stopPropagation|stopImmediatePropagation)\s*\(\s*\)/g, '')
    .replace(/\breturn\s*(?:false|true)?\s*;?/g, '')
    .replace(/\bbreak\s*;?/g, '')
    .replace(/case\s+['"]Enter['"]\s*:/g, '')
    .replace(/[{};,\s]/g, '');
  return stripped.length === 0;
}

/**
 * Checks if an element has been configured with an ARIA button role
 * via setAttribute('role', ...) or .role = ... in the enclosing scope.
 */
function hasAriaButtonRoleAssignment(targetNode: Node, variableName: string): boolean {
  let currentScope: Node | undefined = targetNode.getParent();
  while (
    currentScope &&
    !Node.isSourceFile(currentScope) &&
    !Node.isFunctionDeclaration(currentScope) &&
    !Node.isBlock(currentScope)
  ) {
    currentScope = currentScope.getParent();
  }
  const scopeNode = currentScope ?? targetNode.getSourceFile();
  const fullScopeText = scopeNode.getText();
  if (!fullScopeText.includes('role') && !fullScopeText.includes('Role')) {
    return false;
  }
  const roleRegex = new RegExp(
    `\\b${variableName}\\s*(?:\\.\\s*setAttribute\\s*\\(\\s*['"]role['"]\\s*,\\s*['"](?:button|menuitem|tab|link|switch|checkbox|option)['"]|\\.\\s*role\\s*=\\s*['"](?:button|menuitem|tab|link|switch|checkbox|option)['"])`,
    'i',
  );
  return roleRegex.test(fullScopeText);
}

/**
 * Checks if a condition strictly requires Ctrl or Cmd (Meta) modifier key,
 * properly distinguishing positive requirements from negated guards (e.g. !e.ctrlKey).
 */
function requiresCtrlOrMetaModifier(condText: string): boolean {
  if (/!\s*\([^)]*\b(?:ctrlKey|metaKey|altKey)\b/.test(condText)) {
    return false;
  }
  const hasPositiveCtrl = /(?:^|[^!.\w])(?:\b[a-zA-Z_$][\w$]*\.)?\bctrlKey\b(?!\s*===?\s*false)/.test(condText);
  const hasPositiveMeta = /(?:^|[^!.\w])(?:\b[a-zA-Z_$][\w$]*\.)?\bmetaKey\b(?!\s*===?\s*false)/.test(condText);
  const hasPositiveAlt = /(?:^|[^!.\w])(?:\b[a-zA-Z_$][\w$]*\.)?\baltKey\b(?!\s*===?\s*false)/.test(condText);
  return hasPositiveCtrl || hasPositiveMeta || hasPositiveAlt;
}

const NEGATED_ENTER_REGEX =
  /(?:\bkey\b|\bcode\b)\s*!==?\s*['"]Enter['"]|['"]Enter['"]\s*!==?\s*(?:[\w$]+\.)*(?:\bkey\b|\bcode\b)|!\s*\(\s*(?:\bkey\b|\bcode\b)\s*===?\s*['"]Enter['"]|!\s*\(\s*['"]Enter['"]\s*===?\s*(?:[\w$]+\.)*(?:\bkey\b|\bcode\b)/;

const ASSIGNMENT_OPERATORS = new Set([
  SyntaxKind.EqualsToken,
  SyntaxKind.PlusEqualsToken,
  SyntaxKind.MinusEqualsToken,
  SyntaxKind.AsteriskEqualsToken,
  SyntaxKind.AsteriskAsteriskEqualsToken,
  SyntaxKind.SlashEqualsToken,
  SyntaxKind.PercentEqualsToken,
  SyntaxKind.LessThanLessThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  SyntaxKind.AmpersandEqualsToken,
  SyntaxKind.BarEqualsToken,
  SyntaxKind.CaretEqualsToken,
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/**
 * Whether a condition contains a negated Enter check as one of its top-level
 * boolean terms: `e.key !== 'Enter'`, `'Enter' !== e.key`, or `!(e.key === 'Enter')`,
 * possibly combined with `||` or `&&` (e.g. `e.key !== 'Enter' || busy`).
 */
function hasNegatedEnterTerm(cond: Node): boolean {
  if (Node.isBinaryExpression(cond)) {
    const op = cond.getOperatorToken().getKind();
    if (op === SyntaxKind.BarBarToken || op === SyntaxKind.AmpersandAmpersandToken) {
      return hasNegatedEnterTerm(cond.getLeft()) || hasNegatedEnterTerm(cond.getRight());
    }
  }
  return NEGATED_ENTER_REGEX.test(cond.getText());
}

/**
 * Whether an expression acts when evaluated: it calls something, assigns, or
 * increments/decrements. A bare read (`!e.shiftKey`, a bare identifier) does not.
 */
function hasActionSideEffect(expr: Node): boolean {
  if (Node.isCallExpression(unwrapExpression(expr))) {
    return true;
  }
  if (expr.getDescendantsOfKind(SyntaxKind.CallExpression).length > 0) {
    return true;
  }
  for (const binary of expr.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (ASSIGNMENT_OPERATORS.has(binary.getOperatorToken().getKind())) {
      return true;
    }
  }
  for (const unary of [
    ...expr.getDescendantsOfKind(SyntaxKind.PrefixUnaryExpression),
    ...expr.getDescendantsOfKind(SyntaxKind.PostfixUnaryExpression),
  ]) {
    const op = unary.getOperatorToken();
    if (op === SyntaxKind.PlusPlusToken || op === SyntaxKind.MinusMinusToken) {
      return true;
    }
  }
  return false;
}

/**
 * The statements that run after `node` in program order within the handler:
 * the siblings that follow it in its block, or, when it is the block's last
 * statement, the statements after the enclosing statement, up to the handler.
 * Null when nothing follows.
 */
function statementsAfter(node: Node): string | null {
  let current: Node = node;
  for (;;) {
    const parent = current.getParent();
    if (!parent) {
      return null;
    }
    if (Node.isBlock(parent)) {
      const stmts = parent.getStatements();
      const idx = stmts.findIndex((s) => s === current);
      if (idx >= 0 && idx + 1 < stmts.length) {
        return stmts
          .slice(idx + 1)
          .map((s) => s.getText())
          .join('\n');
      }
      current = parent;
      continue;
    }
    if (
      Node.isArrowFunction(parent) ||
      Node.isFunctionExpression(parent) ||
      Node.isFunctionDeclaration(parent) ||
      Node.isMethodDeclaration(parent) ||
      Node.isSourceFile(parent)
    ) {
      return null;
    }
    current = parent;
  }
}

/**
 * Checks a handler function for an Enter key check lacking isComposing / keyCode 229 guards.
 */
function checkHandlerForUnsafeEnter(handler: Node): AnalyzerMatch | null {
  const handlerText = handler.getText();

  // If the handler already checks isComposing, keyCode 229, or key === 'Process', skip!
  if (
    handlerText.includes('isComposing') ||
    handlerText.includes('229') ||
    handlerText.includes("'Process'") ||
    handlerText.includes('"Process"')
  ) {
    return null;
  }

  // Skip listbox, dropdown, or grid navigation handlers that also handle arrow/space/page keys
  if (WIDGET_NAVIGATION_KEYS_REGEX.test(handlerText)) {
    return null;
  }

  // Check if handler contains an Enter check
  // A negated Enter check (`e.key !== 'Enter'`) also counts: it is the guard
  // of an early-return handler, checked by the loop below.
  if (!ENTER_CHECK_REGEX.test(handlerText) && !NEGATED_ENTER_REGEX.test(handlerText)) {
    return null;
  }

  // Look for IfStatements checking Enter
  const ifStatements = handler.getDescendantsOfKind(SyntaxKind.IfStatement);
  for (const ifStmt of ifStatements) {
    const condText = ifStmt.getExpression().getText();
    if (ENTER_CHECK_REGEX.test(condText)) {
      if (requiresCtrlOrMetaModifier(condText) || SPACE_OR_BUTTON_KEY_REGEX.test(condText)) {
        continue;
      }

      const branchText = ifStmt.getThenStatement().getText();
      if (
        !isSuppressOnlyBranch(branchText) &&
        !SYNTHETIC_KEY_EVENT_REGEX.test(branchText)
      ) {
        return {
          line: ifStmt.getStartLineNumber(),
          message:
            'Keydown Enter listener triggers submission/action without checking event.isComposing or event.keyCode === 229 for IME composition safety',
        };
      }
    }
  }

  // Look for logical-AND shorthand: `e.key === 'Enter' && onSearch()` as the
  // handler's body or an expression/return statement. The Enter check is the
  // left operand and the right side calls or acts, with no `if` in between.
  for (const andExpr of handler.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (andExpr.getOperatorToken().getKind() !== SyntaxKind.AmpersandAmpersandToken) {
      continue;
    }
    // Only when the `&&` itself is what the handler runs for effect: its body,
    // or an expression/return statement. Inside an `if` condition (or any other
    // nested position) it is a guard, not the handler's action.
    const { parent } = getSemanticParent(andExpr);
    if (
      !parent ||
      (!Node.isArrowFunction(parent) &&
        !Node.isFunctionExpression(parent) &&
        !Node.isExpressionStatement(parent) &&
        !Node.isReturnStatement(parent))
    ) {
      continue;
    }
    const leftText = andExpr.getLeft().getText();
    if (!ENTER_CHECK_REGEX.test(leftText)) {
      continue;
    }
    if (requiresCtrlOrMetaModifier(leftText) || SPACE_OR_BUTTON_KEY_REGEX.test(leftText)) {
      continue;
    }
    const right = andExpr.getRight();
    const rightText = right.getText();
    if (isSuppressOnlyBranch(rightText) || SYNTHETIC_KEY_EVENT_REGEX.test(rightText)) {
      continue;
    }
    if (!hasActionSideEffect(right)) {
      continue;
    }
    return {
      line: andExpr.getStartLineNumber(),
      message:
        'Keydown Enter listener triggers submission/action without checking event.isComposing or event.keyCode === 229 for IME composition safety',
    };
  }

  // Look for negated early returns: `if (e.key !== 'Enter' || busy) return;`
  // with the action after the guard. The handler only reaches the action when
  // Enter was pressed (and the other guards are clear), exactly like the `if`
  // form above, but no IfStatement checks Enter positively.
  for (const ifStmt of handler.getDescendantsOfKind(SyntaxKind.IfStatement)) {
    const condText = ifStmt.getExpression().getText();
    if (!hasNegatedEnterTerm(ifStmt.getExpression())) {
      continue;
    }
    if (requiresCtrlOrMetaModifier(condText) || SPACE_OR_BUTTON_KEY_REGEX.test(condText)) {
      continue;
    }
    const thenStmt = ifStmt.getThenStatement();
    const thenText = thenStmt.getText();
    // The branch must only return (possibly after suppression): anything else
    // in the branch means the action lives there, not after the guard.
    if (!/\breturn\b/.test(thenText) || !isSuppressOnlyBranch(thenText)) {
      continue;
    }
    const after = statementsAfter(ifStmt);
    if (!after || isSuppressOnlyBranch(after) || SYNTHETIC_KEY_EVENT_REGEX.test(after)) {
      continue;
    }
    return {
      line: ifStmt.getStartLineNumber(),
      message:
        'Keydown Enter listener triggers submission/action without checking event.isComposing or event.keyCode === 229 for IME composition safety',
    };
  }

  // Look for SwitchStatements on event.key with an 'Enter' case
  const switchStatements = handler.getDescendantsOfKind(SyntaxKind.SwitchStatement);
  for (const switchStmt of switchStatements) {
    const exprText = switchStmt.getExpression().getText();
    if (exprText.includes('key')) {
      const caseBlock = switchStmt.getCaseBlock();
      for (const clause of caseBlock.getClauses()) {
        if (Node.isCaseClause(clause)) {
          const caseExprText = clause.getExpression().getText();
          if (caseExprText === "'Enter'" || caseExprText === '"Enter"') {
            const clauseText = clause.getText();
            if (
              !isSuppressOnlyBranch(clauseText) &&
              !SYNTHETIC_KEY_EVENT_REGEX.test(clauseText)
            ) {
              return {
                line: clause.getStartLineNumber(),
                message:
                  'Keydown Enter listener triggers submission/action without checking event.isComposing or event.keyCode === 229 for IME composition safety',
              };
            }
          }
        }
      }
    }
  }

  return null;
}

/**
 * Resolves a function node if the expression is an identifier referring to a local function.
 */
function resolveHandlerFunction(fnExpr: Node): Node | null {
  const unwrapped = unwrapExpression(fnExpr);
  if (Node.isArrowFunction(unwrapped) || Node.isFunctionExpression(unwrapped)) {
    return unwrapped;
  }
  if (!Node.isIdentifier(unwrapped)) {
    return null;
  }
  const name = unwrapped.getText();
  for (let current: Node | undefined = unwrapped.getParent(); current; current = current.getParent()) {
    if (!Node.isSourceFile(current) && !Node.isBlock(current)) continue;
    for (const stmt of current.getStatements()) {
      if (Node.isFunctionDeclaration(stmt) && stmt.getName() === name) {
        return stmt;
      }
      if (Node.isVariableStatement(stmt)) {
        for (const decl of stmt.getDeclarationList().getDeclarations()) {
          const init = decl.getName() === name ? decl.getInitializer() : undefined;
          if (init) return unwrapExpression(init);
        }
      }
    }
  }
  return null;
}

/**
 * Checks CallExpression for keydown event listener registration.
 */
function matchKeydownCall(callExpr: CallExpression): AnalyzerMatch | null {
  const expr = unwrapExpression(callExpr.getExpression());

  if (Node.isPropertyAccessExpression(expr)) {
    const receiver = unwrapExpression(expr.getExpression());
    if (Node.isIdentifier(receiver)) {
      if (hasAriaButtonRoleAssignment(receiver, receiver.getText())) {
        return null;
      }
    } else if (Node.isCallExpression(receiver)) {
      const callArgs = receiver.getArguments();
      if (callArgs.length > 0) {
        const firstArg = unwrapExpression(callArgs[0]);
        if (Node.isStringLiteral(firstArg)) {
          const selectorText = firstArg.getLiteralValue().toLowerCase();
          if (/role\s*=\s*['"]?(?:button|menuitem|tab|link|switch|checkbox|option)\b/i.test(selectorText)) {
            return null;
          }
        }
      }
    }
  }

  // 1. addEventListener('keydown', handler)
  if (Node.isPropertyAccessExpression(expr) && expr.getName() === 'addEventListener') {
    const receiverText = unwrapExpression(expr.getExpression()).getText();
    const isGlobalTarget =
      receiverText === 'document' ||
      receiverText === 'window' ||
      receiverText === 'globalThis' ||
      receiverText === 'document.body';
    const args = callExpr.getArguments();
    if (args.length >= 2) {
      const eventArg = unwrapExpression(args[0]);
      if (Node.isStringLiteral(eventArg) && eventArg.getLiteralValue() === 'keydown') {
        const handler = resolveHandlerFunction(args[1]);
        if (handler) {
          if (
            isGlobalTarget &&
            !/\b(?:target|srcElement|activeElement|input|textarea|form)\b/i.test(handler.getText())
          ) {
            return null;
          }
          return checkHandlerForUnsafeEnter(handler);
        }
      }
    }
  }

  // 2. $(...).on('keydown', handler) or $(...).on('keydown.namespace', handler)
  if (Node.isPropertyAccessExpression(expr) && expr.getName() === 'on') {
    const args = callExpr.getArguments();
    if (args.length >= 2) {
      const eventArg = unwrapExpression(args[0]);
      if (Node.isStringLiteral(eventArg)) {
        const val = eventArg.getLiteralValue();
        if (val === 'keydown' || val.startsWith('keydown.')) {
          const handlerArg = args.length >= 3 ? args[2] : args[1];
          const handler = resolveHandlerFunction(handlerArg);
          if (handler) {
            return checkHandlerForUnsafeEnter(handler);
          }
        }
      }
    }
  }

  // 3. $(...).keydown(handler)
  if (Node.isPropertyAccessExpression(expr) && expr.getName() === 'keydown') {
    const args = callExpr.getArguments();
    if (args.length >= 1) {
      const handler = resolveHandlerFunction(args[0]);
      if (handler) {
        return checkHandlerForUnsafeEnter(handler);
      }
    }
  }

  return null;
}

/**
 * Checks JSX attributes like onKeyDown={...}.
 */
function matchJsxKeydown(jsxAttr: JsxAttribute): AnalyzerMatch | null {
  const name = jsxAttr.getNameNode().getText();
  if (name !== 'onKeyDown' && name !== 'onkeydown') {
    return null;
  }

  const attributesContainer = jsxAttr.getParent();
  if (attributesContainer) {
    for (const siblingAttr of attributesContainer.getChildrenOfKind(SyntaxKind.JsxAttribute)) {
      if (siblingAttr.getNameNode().getText() === 'role') {
        const init = siblingAttr.getInitializer();
        if (init && Node.isStringLiteral(init)) {
          if (ARIA_BUTTON_ROLES.has(init.getLiteralValue().toLowerCase())) {
            return null;
          }
        }
      }
    }
  }

  const init = jsxAttr.getInitializer();
  if (!init || !Node.isJsxExpression(init)) {
    return null;
  }

  const expr = init.getExpression();
  if (!expr) {
    return null;
  }

  const handler = resolveHandlerFunction(expr);
  if (handler) {
    return checkHandlerForUnsafeEnter(handler);
  }

  return null;
}

export const imeSafeEnterSubmitMatcher: JsRuleMatcher = {
  kind: 'js',
  fastTokens: [
    ['keydown', 'onkeydown', 'onKeyDown'],
    ["'Enter'", '"Enter"'],
    ['key', 'code', 'case '],
  ],
  matchFile(sourceFile: SourceFile, ctx: JsMatcherContext): AnalyzerMatch[] {
    if (ctx.filePath && TEST_FILE_PATH_REGEX.test(ctx.filePath)) {
      return [];
    }
    // A negated Enter check (`e.key !== 'Enter'`) also counts: it is the guard
    // of an early-return handler, checked inside checkHandlerForUnsafeEnter.
    if (
      ctx.fileContent &&
      !ENTER_CHECK_REGEX.test(ctx.fileContent) &&
      !NEGATED_ENTER_REGEX.test(ctx.fileContent)
    ) {
      return [];
    }

    const matches: AnalyzerMatch[] = [];
    const reportedLines = new Set<number>();
    const recordMatch = (match: AnalyzerMatch | null): void => {
      if (match && !reportedLines.has(match.line)) {
        reportedLines.add(match.line);
        matches.push(match);
      }
    };

    for (const callExpr of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      recordMatch(matchKeydownCall(callExpr));
    }

    for (const jsxAttr of sourceFile.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
      recordMatch(matchJsxKeydown(jsxAttr));
    }

    for (const assign of sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
      if (assign.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) {
        continue;
      }
      const left = unwrapExpression(assign.getLeft());
      if (Node.isPropertyAccessExpression(left) && left.getName() === 'onkeydown') {
        const receiver = unwrapExpression(left.getExpression());
        if (
          Node.isIdentifier(receiver) &&
          hasAriaButtonRoleAssignment(receiver, receiver.getText())
        ) {
          continue;
        }
        const handler = resolveHandlerFunction(assign.getRight());
        if (handler) {
          recordMatch(checkHandlerForUnsafeEnter(handler));
        }
      }
    }

    return matches;
  },
};

export const imeSafeEnterSubmitRule: AnalyzerRule = {
  id: 'ime-safe-enter-submit',
  guideId: 'ime-safe-enter-submit',
  guideHash: IME_SAFE_ENTER_SUBMIT_GUIDE_HASH,
  summary:
    'Flag keydown event listeners on inputs or textareas intercepting Enter (event.key or event.code "Enter") to submit forms, send messages, or trigger actions without checking event.isComposing or event.keyCode === 229, breaking IME input in CJK languages.',
  matcher: imeSafeEnterSubmitMatcher,
  verifierRubric: {
    keepWhen: [
      'Keydown event listeners on inputs or textareas checking event.key === "Enter" or event.code === "Enter" to trigger submission, search, or message sending without checking event.isComposing or event.keyCode === 229.',
      'Keydown handlers using logical-AND shorthand (e.key === "Enter" && action()) or negated early returns (if (e.key !== "Enter") return; action()) to trigger submission without checking event.isComposing or event.keyCode === 229.',
      'Custom enter-to-submit implementations intercepting Enter to call form.submit(), form.requestSubmit(), or trigger a click on a submit button without IME composition gating.',
    ],
    dropWhen: [
      'Keyup or keypress event listeners (composition has already ended by keyup).',
      'Handlers that check event.isComposing or event.keyCode === 229.',
      'Handlers that detect Enter only through event.keyCode === 13 or event.which === 13 (the keydown that confirms an IME composition reports keyCode 229, so these never fire mid-composition).',
      'Handlers strictly requiring modifier keys (Ctrl+Enter or Cmd+Enter) where IME character selection is not triggered.',
      'Native form submit events or standard inputs inside a form with no custom Enter keydown listener (native Enter submission handles IME automatically).',
      'Global document-level hotkeys, non-text UI widgets (buttons, menus, tabs, treeviews, dropdowns, modals, media players), or rich-text/code editor newline/indentation handlers rather than text-input submission.',
    ],
  },
};

export default [
  imeSafeEnterSubmitRule,
] satisfies readonly AnalyzerRule[];
