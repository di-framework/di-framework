// @di-framework/tsc injects runtime typeof/shape checks into function
// bodies from parameter types (assertAll). Transparent: no source markers.
// Checks are synthesized as AST nodes (NodeFactory), not text edits.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimchecker "github.com/microsoft/typescript-go/shim/checker"
	shimprinter "github.com/microsoft/typescript-go/shim/printer"

	"github.com/samchon/ttsc/packages/ttsc/driver"
)

type options struct {
	cwd      string
	emit     bool
	noEmit   bool
	outDir   string
	tsconfig string
}

type transformResult struct {
	Diagnostics []any             `json:"diagnostics,omitempty"`
	TypeScript  map[string]string `json:"typescript"`
}

type tsconfigFile struct {
	CompilerOptions struct {
		RootDir string `json:"rootDir"`
	} `json:"compilerOptions"`
}

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "@di-framework/tsc: command required")
		return 2
	}
	switch args[0] {
	case "version", "-v", "--version":
		fmt.Fprintln(os.Stdout, "@di-framework/tsc 0.1.0")
		return 0
	case "check":
		return 0
	case "transform":
		return runTransform(args[1:])
	case "build":
		return runBuild(args[1:])
	default:
		fmt.Fprintf(os.Stderr, "@di-framework/tsc: unknown command %q\n", args[0])
		return 2
	}
}

func runTransform(args []string) int {
	opts, ok := parseOptions("transform", args)
	if !ok {
		return 2
	}
	prog, ok := loadProgram(opts)
	if !ok {
		return 2
	}
	defer prog.Close()

	injectProgram(prog, projectRoot(opts))

	// Host treats typescript[path] as opaque text — print the mutated AST.
	printer := shimprinter.NewPrinter(
		shimprinter.PrinterOptions{},
		shimprinter.PrintHandlers{},
		nil,
	)
	out := transformResult{TypeScript: map[string]string{}}
	for _, file := range prog.SourceFiles() {
		if file == nil || file.IsDeclarationFile {
			continue
		}
		out.TypeScript[outputKey(opts.cwd, file.FileName())] = shimprinter.EmitSourceFile(printer, file)
	}
	data, err := json.Marshal(out)
	if err != nil {
		fmt.Fprintf(os.Stderr, "@di-framework/tsc: marshal failed: %v\n", err)
		return 3
	}
	fmt.Fprintln(os.Stdout, string(data))
	return 0
}

func runBuild(args []string) int {
	opts, ok := parseOptions("build", args)
	if !ok {
		return 2
	}
	prog, ok := loadProgram(opts)
	if !ok {
		return 2
	}
	defer prog.Close()

	injectProgram(prog, projectRoot(opts))
	if opts.noEmit {
		return 0
	}
	_, emitDiags, err := prog.EmitAllRaw(nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "@di-framework/tsc: emit failed: %v\n", err)
		return 3
	}
	for _, d := range emitDiags {
		fmt.Fprintln(os.Stderr, d.String())
	}
	if len(emitDiags) > 0 {
		return 2
	}
	return 0
}

func loadProgram(opts options) (*driver.Program, bool) {
	prog, parseDiags, err := driver.LoadProgram(opts.cwd, opts.tsconfig, driver.LoadProgramOptions{
		ForceEmit:   opts.emit,
		ForceNoEmit: opts.noEmit,
		OutDir:      opts.outDir,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "@di-framework/tsc: %v\n", err)
		return nil, false
	}
	if len(parseDiags) > 0 {
		driver.WritePrettyDiagnostics(os.Stderr, parseDiags, opts.cwd)
		prog.Close()
		return nil, false
	}
	if diags := prog.Diagnostics(); len(diags) > 0 {
		driver.WritePrettyDiagnostics(os.Stderr, diags, opts.cwd)
		prog.Close()
		return nil, false
	}
	return prog, true
}

func projectRoot(opts options) string {
	root := opts.cwd
	data, err := os.ReadFile(opts.tsconfig)
	if err != nil {
		return root
	}
	var config tsconfigFile
	if json.Unmarshal(data, &config) != nil || config.CompilerOptions.RootDir == "" {
		return root
	}
	return filepath.Clean(filepath.Join(filepath.Dir(opts.tsconfig), config.CompilerOptions.RootDir))
}

func isWithinRoot(fileName string, root string) bool {
	rel, err := filepath.Rel(root, fileName)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func injectProgram(prog *driver.Program, root string) {
	factory := shimast.NewNodeFactory(shimast.NodeFactoryHooks{})
	for _, file := range prog.SourceFiles() {
		if file == nil || file.IsDeclarationFile || !isWithinRoot(file.FileName(), root) {
			continue
		}
		injectFile(factory, file, prog.Checker)
	}
}

func injectFile(factory *shimast.NodeFactory, file *shimast.SourceFile, checker *shimchecker.Checker) {
	var walk func(node *shimast.Node)
	walk = func(node *shimast.Node) {
		if node == nil {
			return
		}
		switch node.Kind {
		case shimast.KindFunctionDeclaration:
			fn := node.AsFunctionDeclaration()
			injectCallable(factory, checker, node, fn.Parameters, fn.Body)
		case shimast.KindMethodDeclaration:
			method := node.AsMethodDeclaration()
			injectCallable(factory, checker, node, method.Parameters, method.Body)
		case shimast.KindConstructor:
			ctor := node.AsConstructorDeclaration()
			injectCallable(factory, checker, node, ctor.Parameters, ctor.Body)
		case shimast.KindFunctionExpression:
			fn := node.AsFunctionExpression()
			injectCallable(factory, checker, node, fn.Parameters, fn.Body)
		case shimast.KindArrowFunction:
			arrow := node.AsArrowFunction()
			if arrow.Body != nil && arrow.Body.Kind == shimast.KindBlock {
				injectCallable(factory, checker, node, arrow.Parameters, arrow.Body)
			} else if arrow.Body != nil {
				checks := checksForParams(factory, checker, node, arrow.Parameters)
				if len(checks) > 0 {
					stmts := append(checks, factory.NewReturnStatement(arrow.Body))
					arrow.Body = factory.NewBlock(factory.NewNodeList(stmts), true)
					shimast.SetParentInChildren(node)
				}
			}
		}
		node.ForEachChild(func(child *shimast.Node) bool {
			walk(child)
			return false
		})
	}
	if file.Statements != nil {
		for _, stmt := range file.Statements.Nodes {
			walk(stmt)
		}
	}
}

func injectCallable(
	factory *shimast.NodeFactory,
	checker *shimchecker.Checker,
	enclosing *shimast.Node,
	params *shimast.NodeList,
	body *shimast.Node,
) {
	if body == nil || params == nil {
		return
	}
	block := body.AsBlock()
	if block == nil || block.Statements == nil {
		return
	}

	checks := checksForParams(factory, checker, enclosing, params)
	if len(checks) == 0 {
		return
	}

	// Structural prepend — printer walks Statements.Nodes directly.
	out := make([]*shimast.Node, 0, len(checks)+len(block.Statements.Nodes))
	out = append(out, checks...)
	out = append(out, block.Statements.Nodes...)
	block.Statements.Nodes = out
	// Emit walks parents; factory nodes start detached.
	shimast.SetParentInChildren(body)
}

func checksForParams(
	factory *shimast.NodeFactory,
	checker *shimchecker.Checker,
	enclosing *shimast.Node,
	params *shimast.NodeList,
) []*shimast.Node {
	if params == nil {
		return nil
	}
	var checks []*shimast.Node
	for _, param := range params.Nodes {
		if param == nil || param.Kind != shimast.KindParameter {
			continue
		}
		p := param.AsParameterDeclaration()
		if p == nil || p.Name() == nil {
			continue
		}
		if p.Name().Kind == shimast.KindObjectBindingPattern || p.Name().Kind == shimast.KindArrayBindingPattern {
			checks = append(checks, checksForBindingName(factory, checker, enclosing, p.Name())...)
			continue
		}
		if p.Name().Kind != shimast.KindIdentifier {
			continue
		}
		name := p.Name().Text()
		paramChecks := checksForParam(factory, checker, enclosing, param, name)
		if len(paramChecks) == 0 {
			continue
		}
		if p.QuestionToken != nil || p.Initializer != nil {
			present := binary(factory, pathExpr(factory, name), shimast.KindExclamationEqualsEqualsToken, factory.NewIdentifier("undefined"))
			checks = append(checks, factory.NewIfStatement(present, factory.NewBlock(factory.NewNodeList(paramChecks), true), nil))
			continue
		}
		checks = append(checks, paramChecks...)
	}
	return checks
}

func checksForBindingName(
	factory *shimast.NodeFactory,
	checker *shimchecker.Checker,
	enclosing *shimast.Node,
	name *shimast.Node,
) []*shimast.Node {
	if name == nil || checker == nil {
		return nil
	}
	if name.Kind == shimast.KindIdentifier {
		t := checker.GetTypeAtLocation(name)
		if t == nil {
			return nil
		}
		return stmtsFromCheckerType(factory, checker, enclosing, name.Text(), t)
	}
	if name.Kind != shimast.KindObjectBindingPattern && name.Kind != shimast.KindArrayBindingPattern {
		return nil
	}
	pattern := name.AsBindingPattern()
	if pattern == nil || pattern.Elements == nil {
		return nil
	}
	var out []*shimast.Node
	for _, raw := range pattern.Elements.Nodes {
		if raw == nil || raw.Kind != shimast.KindBindingElement {
			continue
		}
		element := raw.AsBindingElement()
		if element == nil || element.Name() == nil || element.DotDotDotToken != nil || element.Initializer != nil {
			continue
		}
		out = append(out, checksForBindingName(factory, checker, enclosing, element.Name())...)
	}
	return out
}

func checksForParam(
	factory *shimast.NodeFactory,
	checker *shimchecker.Checker,
	enclosing *shimast.Node,
	param *shimast.Node,
	path string,
) []*shimast.Node {
	p := param.AsParameterDeclaration()
	if p != nil && p.Type != nil {
		if stmts := stmtsFromTypeNode(factory, path, p.Type); len(stmts) > 0 {
			return stmts
		}
	}
	if checker == nil {
		return nil
	}
	t := checker.GetTypeAtLocation(param)
	if t == nil {
		return nil
	}
	return stmtsFromCheckerType(factory, checker, enclosing, path, t)
}

func stmtsFromTypeNode(
	factory *shimast.NodeFactory,
	path string,
	typeNode *shimast.Node,
) []*shimast.Node {
	if typeNode == nil {
		return nil
	}
	switch typeNode.Kind {
	case shimast.KindStringKeyword:
		return []*shimast.Node{typeofCheck(factory, path, "string")}
	case shimast.KindNumberKeyword:
		return []*shimast.Node{typeofCheck(factory, path, "number")}
	case shimast.KindBooleanKeyword:
		return []*shimast.Node{typeofCheck(factory, path, "boolean")}
	case shimast.KindBigIntKeyword:
		return []*shimast.Node{typeofCheck(factory, path, "bigint")}
	default:
		return nil
	}
}

func stmtsFromCheckerType(
	factory *shimast.NodeFactory,
	checker *shimchecker.Checker,
	enclosing *shimast.Node,
	path string,
	t *shimchecker.Type,
) []*shimast.Node {
	return stmtsFromCheckerTypeSeen(factory, checker, enclosing, path, t, newPredicateState(path), 0)
}

type predicateState struct {
	active      map[*shimchecker.Type]bool
	identifiers map[string]bool
}

func newPredicateState(path string) *predicateState {
	rootEnd := strings.IndexAny(path, ".[")
	if rootEnd < 0 {
		rootEnd = len(path)
	}
	return &predicateState{
		active:      make(map[*shimchecker.Type]bool),
		identifiers: map[string]bool{path[:rootEnd]: true},
	}
}

func (state *predicateState) clone() *predicateState {
	clone := &predicateState{
		active:      make(map[*shimchecker.Type]bool, len(state.active)),
		identifiers: make(map[string]bool, len(state.identifiers)),
	}
	for t, active := range state.active {
		clone.active[t] = active
	}
	for name, used := range state.identifiers {
		clone.identifiers[name] = used
	}
	return clone
}

func (state *predicateState) freshIdentifier(base string) string {
	if !state.identifiers[base] {
		state.identifiers[base] = true
		return base
	}
	for suffix := 1; ; suffix++ {
		candidate := fmt.Sprintf("%s_%d", base, suffix)
		if !state.identifiers[candidate] {
			state.identifiers[candidate] = true
			return candidate
		}
	}
}

func stmtsFromCheckerTypeSeen(
	factory *shimast.NodeFactory,
	checker *shimchecker.Checker,
	enclosing *shimast.Node,
	path string,
	t *shimchecker.Type,
	state *predicateState,
	depth int,
) []*shimast.Node {
	// Platform and application interfaces can be recursive. Runtime guards are
	// deliberately bounded so a cyclic type graph cannot make compilation hang.
	if depth > 8 || state.active[t] {
		return nil
	}
	flags := t.Flags()
	switch {
	case flags&shimchecker.TypeFlagsEnumLike != 0:
		invalid, ok := enumInvalidPredicate(factory, path, t)
		if !ok {
			return nil
		}
		return []*shimast.Node{throwIf(factory, invalid, "Expected "+path+" to be a valid enum value")}
	case classTypeSymbol(t) != nil:
		invalid, className, ok := classInvalidPredicate(factory, checker, enclosing, path, t)
		if !ok {
			return nil
		}
		return []*shimast.Node{throwIf(factory, invalid, "Expected "+path+" to be an instance of "+className)}
	case flags&shimchecker.TypeFlagsUnion != 0:
		members := t.Types()
		if len(members) == 0 || len(members) > 12 {
			return nil
		}
		var invalid *shimast.Expression
		for _, member := range members {
			memberInvalid, ok := invalidPredicate(factory, checker, enclosing, path, member, state, depth+1)
			if !ok {
				return nil
			}
			if invalid == nil {
				invalid = memberInvalid
			} else {
				invalid = binary(factory, invalid, shimast.KindAmpersandAmpersandToken, memberInvalid)
			}
		}
		return []*shimast.Node{throwIf(factory, invalid, "Expected "+path+" to match its union type")}
	case flags&shimchecker.TypeFlagsIntersection != 0:
		if base, ok := brandedBaseType(checker, t); ok {
			return stmtsFromCheckerTypeSeen(factory, checker, enclosing, path, base, state, depth+1)
		}
		if !isStructuralIntersection(checker, t) {
			return nil
		}
		return structuralStatements(factory, checker, enclosing, path, t, state, depth)
	case flags&shimchecker.TypeFlagsNull != 0:
		return []*shimast.Node{equalityCheck(factory, path, factory.NewToken(shimast.KindNullKeyword), "null")}
	case flags&shimchecker.TypeFlagsUndefined != 0:
		return []*shimast.Node{equalityCheck(factory, path, factory.NewIdentifier("undefined"), "undefined")}
	case flags&shimchecker.TypeFlagsStringLiteral != 0:
		value, ok := t.AsLiteralType().Value().(string)
		if !ok {
			return nil
		}
		return []*shimast.Node{equalityCheck(factory, path, factory.NewStringLiteral(value, shimast.TokenFlagsNone), fmt.Sprintf("%q", value))}
	case flags&shimchecker.TypeFlagsNumberLiteral != 0:
		value := fmt.Sprint(t.AsLiteralType().Value())
		return []*shimast.Node{equalityCheck(factory, path, factory.NewNumericLiteral(value, shimast.TokenFlagsNone), value)}
	case flags&shimchecker.TypeFlagsBooleanLiteral != 0:
		value, ok := t.AsLiteralType().Value().(bool)
		if !ok {
			return nil
		}
		kind, label := shimast.KindFalseKeyword, "false"
		if value {
			kind, label = shimast.KindTrueKeyword, "true"
		}
		return []*shimast.Node{equalityCheck(factory, path, factory.NewToken(kind), label)}
	case flags&shimchecker.TypeFlagsBigIntLiteral != 0:
		value := fmt.Sprint(t.AsLiteralType().Value()) + "n"
		return []*shimast.Node{equalityCheck(factory, path, factory.NewBigIntLiteral(value, shimast.TokenFlagsNone), value)}
	case flags&shimchecker.TypeFlagsTemplateLiteral != 0:
		invalid, ok := templateLiteralInvalidPredicate(factory, path, t)
		if !ok {
			return nil
		}
		return []*shimast.Node{throwIf(factory, invalid, "Expected "+path+" to match its template literal type")}
	case flags&shimchecker.TypeFlagsString != 0:
		return []*shimast.Node{typeofCheck(factory, path, "string")}
	case flags&shimchecker.TypeFlagsNumber != 0:
		return []*shimast.Node{typeofCheck(factory, path, "number")}
	case flags&shimchecker.TypeFlagsBoolean != 0:
		return []*shimast.Node{typeofCheck(factory, path, "boolean")}
	case flags&shimchecker.TypeFlagsBigInt != 0:
		return []*shimast.Node{typeofCheck(factory, path, "bigint")}
	case flags&shimchecker.TypeFlagsObject != 0 && checker.IsArrayLikeType(t) && !shimchecker.IsTupleType(t):
		invalid, ok := arrayInvalidPredicate(factory, checker, enclosing, path, t, state, depth)
		if !ok {
			return nil
		}
		return []*shimast.Node{throwIf(factory, invalid, "Expected "+path+" to be an array with valid elements")}
	case flags&shimchecker.TypeFlagsObject != 0 && shimchecker.IsTupleType(t):
		invalid, ok := tupleInvalidPredicate(factory, checker, enclosing, path, t, state, depth)
		if !ok {
			return nil
		}
		return []*shimast.Node{throwIf(factory, invalid, "Expected "+path+" to be a valid tuple")}
	case flags&shimchecker.TypeFlagsObject != 0:
		return structuralStatements(factory, checker, enclosing, path, t, state, depth)
	default:
		return nil
	}
}

// invalidPredicate returns a composable expression that is true when path does
// not satisfy t. The bool is false when a sound runtime predicate is not
// available; callers then skip the entire union rather than partially checking it.
func invalidPredicate(
	factory *shimast.NodeFactory,
	checker *shimchecker.Checker,
	enclosing *shimast.Node,
	path string,
	t *shimchecker.Type,
	state *predicateState,
	depth int,
) (*shimast.Expression, bool) {
	if t == nil || depth > 8 || state.active[t] {
		return nil, false
	}
	flags := t.Flags()
	switch {
	case flags&shimchecker.TypeFlagsEnumLike != 0:
		return enumInvalidPredicate(factory, path, t)
	case classTypeSymbol(t) != nil:
		invalid, _, ok := classInvalidPredicate(factory, checker, enclosing, path, t)
		return invalid, ok
	case flags&shimchecker.TypeFlagsUnion != 0:
		members := t.Types()
		if len(members) == 0 || len(members) > 12 {
			return nil, false
		}
		var out *shimast.Expression
		for _, member := range members {
			pred, ok := invalidPredicate(factory, checker, enclosing, path, member, state, depth+1)
			if !ok {
				return nil, false
			}
			if out == nil {
				out = pred
			} else {
				out = binary(factory, out, shimast.KindAmpersandAmpersandToken, pred)
			}
		}
		return out, true
	case flags&shimchecker.TypeFlagsIntersection != 0:
		if base, ok := brandedBaseType(checker, t); ok {
			return invalidPredicate(factory, checker, enclosing, path, base, state, depth+1)
		}
		if !isStructuralIntersection(checker, t) {
			return nil, false
		}
		return structuralInvalidPredicate(factory, checker, enclosing, path, t, state, depth)
	case flags&shimchecker.TypeFlagsNull != 0:
		return binary(factory, pathExpr(factory, path), shimast.KindExclamationEqualsEqualsToken, factory.NewToken(shimast.KindNullKeyword)), true
	case flags&shimchecker.TypeFlagsUndefined != 0:
		return binary(factory, pathExpr(factory, path), shimast.KindExclamationEqualsEqualsToken, factory.NewIdentifier("undefined")), true
	case flags&shimchecker.TypeFlagsStringLiteral != 0:
		value, ok := t.AsLiteralType().Value().(string)
		if !ok {
			return nil, false
		}
		return binary(factory, pathExpr(factory, path), shimast.KindExclamationEqualsEqualsToken, factory.NewStringLiteral(value, shimast.TokenFlagsNone)), true
	case flags&shimchecker.TypeFlagsNumberLiteral != 0:
		return binary(factory, pathExpr(factory, path), shimast.KindExclamationEqualsEqualsToken, factory.NewNumericLiteral(fmt.Sprint(t.AsLiteralType().Value()), shimast.TokenFlagsNone)), true
	case flags&shimchecker.TypeFlagsBooleanLiteral != 0:
		value, ok := t.AsLiteralType().Value().(bool)
		if !ok {
			return nil, false
		}
		kind := shimast.KindFalseKeyword
		if value {
			kind = shimast.KindTrueKeyword
		}
		return binary(factory, pathExpr(factory, path), shimast.KindExclamationEqualsEqualsToken, factory.NewToken(kind)), true
	case flags&shimchecker.TypeFlagsBigIntLiteral != 0:
		value := fmt.Sprint(t.AsLiteralType().Value()) + "n"
		return binary(factory, pathExpr(factory, path), shimast.KindExclamationEqualsEqualsToken, factory.NewBigIntLiteral(value, shimast.TokenFlagsNone)), true
	case flags&shimchecker.TypeFlagsTemplateLiteral != 0:
		return templateLiteralInvalidPredicate(factory, path, t)
	case flags&shimchecker.TypeFlagsString != 0:
		return binary(factory, factory.NewTypeOfExpression(pathExpr(factory, path)), shimast.KindExclamationEqualsEqualsToken, factory.NewStringLiteral("string", shimast.TokenFlagsNone)), true
	case flags&shimchecker.TypeFlagsNumber != 0:
		return binary(factory, factory.NewTypeOfExpression(pathExpr(factory, path)), shimast.KindExclamationEqualsEqualsToken, factory.NewStringLiteral("number", shimast.TokenFlagsNone)), true
	case flags&shimchecker.TypeFlagsBoolean != 0:
		return binary(factory, factory.NewTypeOfExpression(pathExpr(factory, path)), shimast.KindExclamationEqualsEqualsToken, factory.NewStringLiteral("boolean", shimast.TokenFlagsNone)), true
	case flags&shimchecker.TypeFlagsBigInt != 0:
		return binary(factory, factory.NewTypeOfExpression(pathExpr(factory, path)), shimast.KindExclamationEqualsEqualsToken, factory.NewStringLiteral("bigint", shimast.TokenFlagsNone)), true
	case flags&shimchecker.TypeFlagsObject != 0 && checker.IsArrayLikeType(t) && !shimchecker.IsTupleType(t):
		return arrayInvalidPredicate(factory, checker, enclosing, path, t, state, depth)
	case flags&shimchecker.TypeFlagsObject != 0 && shimchecker.IsTupleType(t):
		return tupleInvalidPredicate(factory, checker, enclosing, path, t, state, depth)
	case flags&shimchecker.TypeFlagsObject != 0:
		return structuralInvalidPredicate(factory, checker, enclosing, path, t, state, depth)
	default:
		return nil, false
	}
}

// brandedBaseType recognizes erased nominal types such as
// string & { readonly __brand: unique symbol }. Exactly one runtime-checkable
// primitive base is required; every other constituent must be a non-empty
// plain object marker. Marker properties are intentionally never inspected at
// runtime because TypeScript brands do not exist in emitted JavaScript.
func brandedBaseType(checker *shimchecker.Checker, t *shimchecker.Type) (*shimchecker.Type, bool) {
	var base *shimchecker.Type
	markerCount := 0
	for _, member := range t.Types() {
		if member == nil {
			return nil, false
		}
		if isBrandBaseType(member) {
			if base != nil {
				return nil, false
			}
			base = member
			continue
		}
		if !isBrandMarkerType(checker, member) {
			return nil, false
		}
		markerCount++
	}
	return base, base != nil && markerCount > 0
}

func isBrandBaseType(t *shimchecker.Type) bool {
	flags := t.Flags()
	return flags&(shimchecker.TypeFlagsString|shimchecker.TypeFlagsNumber|shimchecker.TypeFlagsBoolean|shimchecker.TypeFlagsBigInt|shimchecker.TypeFlagsStringLiteral|shimchecker.TypeFlagsNumberLiteral|shimchecker.TypeFlagsBooleanLiteral|shimchecker.TypeFlagsBigIntLiteral|shimchecker.TypeFlagsTemplateLiteral) != 0
}

func isBrandMarkerType(checker *shimchecker.Checker, t *shimchecker.Type) bool {
	if t.Flags()&shimchecker.TypeFlagsObject == 0 ||
		isClassObjectType(t) ||
		checker.IsArrayLikeType(t) ||
		shimchecker.IsTupleType(t) ||
		len(shimchecker.Checker_getSignaturesOfType(checker, t, shimchecker.SignatureKindCall)) > 0 ||
		len(shimchecker.Checker_getSignaturesOfType(checker, t, shimchecker.SignatureKindConstruct)) > 0 ||
		len(shimchecker.Checker_getIndexInfosOfType(checker, t)) > 0 {
		return false
	}

	properties := shimchecker.Checker_getApparentProperties(checker, t)
	if len(properties) == 0 {
		return false
	}
	for _, property := range properties {
		if property == nil {
			return false
		}
		if isUniqueSymbolMarkerProperty(property.Name) {
			continue
		}
		if !conventionalBrandMarkerNames[property.Name] {
			return false
		}
		propertyType := shimchecker.Checker_getTypeOfPropertyOfType(checker, t, property.Name)
		if !isBrandMarkerValueType(propertyType) {
			return false
		}
	}
	return true
}

var conventionalBrandMarkerNames = map[string]bool{
	"__brand": true,
	"_brand":  true,
	"_tag":    true,
	"__tag":   true,
	"__type":  true,
	"_type":   true,
	"brand":   true,
}

func isClassObjectType(t *shimchecker.Type) bool {
	if t.ObjectFlags()&shimchecker.ObjectFlagsClass != 0 ||
		t.Symbol() != nil && t.Symbol().Flags&shimast.SymbolFlagsClass != 0 {
		return true
	}
	if t.ObjectFlags()&shimchecker.ObjectFlagsReference == 0 {
		return false
	}
	target := t.Target()
	return target != nil && (target.ObjectFlags()&shimchecker.ObjectFlagsClass != 0 ||
		target.Symbol() != nil && target.Symbol().Flags&shimast.SymbolFlagsClass != 0)
}

// Unique symbol property names are encoded by typescript-go as
// <internal-prefix>@<symbol-name>@<numeric-id>. Well-known symbols omit the
// numeric identity suffix and are therefore not treated as nominal markers.
func isUniqueSymbolMarkerProperty(name string) bool {
	if len(name) < 4 || name[0] != 0xfe || name[1] != '@' {
		return false
	}
	lastAt := strings.LastIndexByte(name, '@')
	if lastAt <= 1 || lastAt == len(name)-1 {
		return false
	}
	_, err := strconv.ParseUint(name[lastAt+1:], 10, 64)
	return err == nil
}

func isBrandMarkerValueType(t *shimchecker.Type) bool {
	if t == nil {
		return false
	}
	flags := t.Flags()
	if flags&(shimchecker.TypeFlagsStringLiteral|shimchecker.TypeFlagsNumberLiteral|shimchecker.TypeFlagsBooleanLiteral|shimchecker.TypeFlagsBigIntLiteral|shimchecker.TypeFlagsUniqueESSymbol|shimchecker.TypeFlagsNever) != 0 {
		return true
	}
	if flags&shimchecker.TypeFlagsUnion == 0 || len(t.Types()) == 0 {
		return false
	}
	for _, member := range t.Types() {
		if !isBrandMarkerValueType(member) {
			return false
		}
	}
	return true
}

// templateLiteralInvalidPredicate always checks the string representation. A
// template with exactly one string-like placeholder can also enforce its
// fixed prefix and suffix cheaply. Complex templates deliberately fall back
// to typeof rather than approximating their language with an unsound regex.
func templateLiteralInvalidPredicate(
	factory *shimast.NodeFactory,
	path string,
	t *shimchecker.Type,
) (*shimast.Expression, bool) {
	template := t.AsTemplateLiteralType()
	if template == nil {
		return nil, false
	}
	notString := binary(factory, factory.NewTypeOfExpression(pathExpr(factory, path)), shimast.KindExclamationEqualsEqualsToken, factory.NewStringLiteral("string", shimast.TokenFlagsNone))
	texts, placeholders := template.Texts(), template.Types()
	if len(texts) != len(placeholders)+1 {
		return nil, false
	}
	if len(placeholders) != 1 || !isStringLikeType(placeholders[0]) {
		return notString, true
	}
	out := notString
	if texts[0] != "" {
		out = binary(factory, out, shimast.KindBarBarToken, stringMethodInvalidPredicate(factory, path, "startsWith", texts[0]))
	}
	if texts[1] != "" {
		out = binary(factory, out, shimast.KindBarBarToken, stringMethodInvalidPredicate(factory, path, "endsWith", texts[1]))
	}
	return out, true
}

func isStringLikeType(t *shimchecker.Type) bool {
	if t == nil {
		return false
	}
	return t.Flags()&(shimchecker.TypeFlagsString|shimchecker.TypeFlagsStringLiteral|shimchecker.TypeFlagsTemplateLiteral|shimchecker.TypeFlagsStringMapping) != 0
}

func stringMethodInvalidPredicate(factory *shimast.NodeFactory, path, method, value string) *shimast.Expression {
	call := factory.NewCallExpression(
		factory.NewPropertyAccessExpression(pathExpr(factory, path), nil, factory.NewIdentifier(method), 0),
		nil,
		nil,
		factory.NewNodeList([]*shimast.Node{factory.NewStringLiteral(value, shimast.TokenFlagsNone)}),
		0,
	)
	return factory.NewPrefixUnaryExpression(shimast.KindExclamationToken, call)
}

// isStructuralIntersection keeps primitive/object intersections (including
// brands) out of this generic structural path. Arrays and tuples intersected
// with objects also need semantics beyond a flattened property walk.
func isStructuralIntersection(checker *shimchecker.Checker, t *shimchecker.Type) bool {
	members := t.Types()
	if len(members) == 0 ||
		len(shimchecker.Checker_getSignaturesOfType(checker, t, shimchecker.SignatureKindCall)) > 0 ||
		len(shimchecker.Checker_getSignaturesOfType(checker, t, shimchecker.SignatureKindConstruct)) > 0 {
		return false
	}
	for _, member := range members {
		if member == nil ||
			member.Flags()&shimchecker.TypeFlagsObject == 0 ||
			checker.IsArrayLikeType(member) ||
			shimchecker.IsTupleType(member) ||
			len(shimchecker.Checker_getSignaturesOfType(checker, member, shimchecker.SignatureKindCall)) > 0 ||
			len(shimchecker.Checker_getSignaturesOfType(checker, member, shimchecker.SignatureKindConstruct)) > 0 {
			return false
		}
	}
	return true
}

// structuralStatements emits readable, per-path checks after first proving
// that the complete structural predicate is representable. That preflight
// prevents an unsupported property or index value from producing a partial
// guard that could reject valid inputs.
func structuralStatements(
	factory *shimast.NodeFactory,
	checker *shimchecker.Checker,
	enclosing *shimast.Node,
	path string,
	t *shimchecker.Type,
	state *predicateState,
	depth int,
) []*shimast.Node {
	if _, ok := structuralInvalidPredicate(factory, checker, enclosing, path, t, state.clone(), depth); !ok {
		return nil
	}
	state.active[t] = true
	defer delete(state.active, t)

	out := []*shimast.Node{objectCheck(factory, path)}
	propertyNames := make(map[string]bool)
	for _, sym := range shimchecker.Checker_getApparentProperties(checker, t) {
		if !isRuntimeProperty(sym, propertyNames) || sym.Flags&shimast.SymbolFlagsOptional != 0 {
			continue
		}
		propName := sym.Name
		propType := shimchecker.Checker_getTypeOfPropertyOfType(checker, t, propName)
		out = append(out, requiredPropertyCheck(factory, path, propName))
		out = append(out, stmtsFromCheckerTypeSeen(
			factory,
			checker,
			enclosing,
			propertyPath(path, propName),
			propType,
			state,
			depth+1,
		)...)
	}

	indexType, hasStringIndex, _ := stringIndexValueType(checker, t)
	if hasStringIndex {
		invalid, _ := stringIndexInvalidPredicate(factory, checker, enclosing, path, indexType, state, depth)
		out = append(out, throwIf(factory, invalid, "Expected "+path+" to have valid string-indexed values"))
	}
	return out
}

// structuralInvalidPredicate composes object, required-property, and string
// index checks so structural types remain usable inside unions and arrays.
func structuralInvalidPredicate(
	factory *shimast.NodeFactory,
	checker *shimchecker.Checker,
	enclosing *shimast.Node,
	path string,
	t *shimchecker.Type,
	state *predicateState,
	depth int,
) (*shimast.Expression, bool) {
	if t == nil || depth > 8 || state.active[t] {
		return nil, false
	}
	state.active[t] = true
	defer delete(state.active, t)

	notObject := binary(factory, factory.NewTypeOfExpression(pathExpr(factory, path)), shimast.KindExclamationEqualsEqualsToken, factory.NewStringLiteral("object", shimast.TokenFlagsNone))
	out := binary(factory, notObject, shimast.KindBarBarToken, binary(factory, pathExpr(factory, path), shimast.KindEqualsEqualsEqualsToken, factory.NewToken(shimast.KindNullKeyword)))
	hasShape := false
	propertyNames := make(map[string]bool)
	for _, sym := range shimchecker.Checker_getApparentProperties(checker, t) {
		if !isRuntimeProperty(sym, propertyNames) {
			continue
		}
		hasShape = true
		if sym.Flags&shimast.SymbolFlagsOptional != 0 {
			continue
		}
		propType := shimchecker.Checker_getTypeOfPropertyOfType(checker, t, sym.Name)
		pred, ok := invalidPredicate(factory, checker, enclosing, propertyPath(path, sym.Name), propType, state, depth+1)
		if !ok {
			return nil, false
		}
		missing := missingPropertyPredicate(factory, path, sym.Name)
		out = binary(factory, out, shimast.KindBarBarToken, binary(factory, missing, shimast.KindBarBarToken, pred))
	}

	indexType, hasStringIndex, ok := stringIndexValueType(checker, t)
	if !ok {
		return nil, false
	}
	if hasStringIndex {
		hasShape = true
		invalid, valid := stringIndexInvalidPredicate(factory, checker, enclosing, path, indexType, state, depth)
		if !valid {
			return nil, false
		}
		out = binary(factory, out, shimast.KindBarBarToken, invalid)
	}
	if !hasShape {
		return nil, false
	}
	return out, true
}

// enumInvalidPredicate inlines the checker-known enum member values. This is
// deliberately independent of the emitted enum object so it also works for
// const enums. A computed member has a nil checker value; in that case the
// complete enum guard is skipped instead of rejecting a valid runtime value.
func enumInvalidPredicate(
	factory *shimast.NodeFactory,
	path string,
	t *shimchecker.Type,
) (*shimast.Expression, bool) {
	if t == nil || t.Flags()&shimchecker.TypeFlagsEnumLike == 0 {
		return nil, false
	}
	members := []*shimchecker.Type{t}
	if t.Flags()&shimchecker.TypeFlagsUnion != 0 {
		members = t.Types()
	}
	if len(members) == 0 {
		return nil, false
	}

	seen := make(map[string]bool, len(members))
	var invalid *shimast.Expression
	for _, member := range members {
		if member == nil || member.Flags()&shimchecker.TypeFlagsEnumLike == 0 {
			return nil, false
		}
		value := member.AsLiteralType().Value()
		if value == nil {
			return nil, false
		}
		var expected *shimast.Expression
		var key string
		switch {
		case member.Flags()&shimchecker.TypeFlagsStringLiteral != 0:
			text, ok := value.(string)
			if !ok {
				return nil, false
			}
			expected = factory.NewStringLiteral(text, shimast.TokenFlagsNone)
			key = "string:" + text
		case member.Flags()&shimchecker.TypeFlagsNumberLiteral != 0:
			text := fmt.Sprint(value)
			expected = factory.NewNumericLiteral(text, shimast.TokenFlagsNone)
			key = "number:" + text
		default:
			return nil, false
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		memberInvalid := binary(factory, pathExpr(factory, path), shimast.KindExclamationEqualsEqualsToken, expected)
		if invalid == nil {
			invalid = memberInvalid
		} else {
			invalid = binary(factory, invalid, shimast.KindAmpersandAmpersandToken, memberInvalid)
		}
	}
	return invalid, invalid != nil
}

func classTypeSymbol(t *shimchecker.Type) *shimast.Symbol {
	if t == nil || t.Flags()&shimchecker.TypeFlagsObject == 0 {
		return nil
	}
	candidates := []*shimast.Symbol{t.Symbol(), shimchecker.Type_getTypeNameSymbol(t)}
	if t.ObjectFlags()&shimchecker.ObjectFlagsReference != 0 {
		target := t.Target()
		if target != nil {
			candidates = append(candidates, target.Symbol(), shimchecker.Type_getTypeNameSymbol(target))
		}
	}
	for _, symbol := range candidates {
		if symbol != nil && symbol.Flags&shimast.SymbolFlagsClass != 0 {
			return symbol
		}
	}
	return nil
}

func classInvalidPredicate(
	factory *shimast.NodeFactory,
	checker *shimchecker.Checker,
	enclosing *shimast.Node,
	path string,
	t *shimchecker.Type,
) (*shimast.Expression, string, bool) {
	symbol := classTypeSymbol(t)
	if symbol == nil || !shimchecker.Checker_isSymbolAccessibleAsValue(checker, symbol, enclosing) {
		return nil, "", false
	}
	className := shimchecker.Checker_symbolToValueString(checker, symbol, enclosing)
	constructor, ok := qualifiedValueExpr(factory, className)
	if !ok || !hasRuntimeValueBinding(factory, checker, enclosing, className) {
		return nil, "", false
	}
	isInstance := binary(factory, pathExpr(factory, path), shimast.KindInstanceOfKeyword, constructor)
	return factory.NewPrefixUnaryExpression(shimast.KindExclamationToken, isInstance), className, true
}

func hasRuntimeValueBinding(
	factory *shimast.NodeFactory,
	checker *shimchecker.Checker,
	enclosing *shimast.Node,
	name string,
) bool {
	root, _, _ := strings.Cut(name, ".")
	binding := shimchecker.Checker_resolveEntityName(
		checker,
		factory.NewIdentifier(root),
		shimast.SymbolFlagsValue,
		true,
		true,
		enclosing,
	)
	if binding == nil {
		return false
	}
	for _, declaration := range binding.Declarations {
		if declaration == nil {
			continue
		}
		for current := declaration; current != nil; current = current.Parent {
			// Emit decides whether an ES import survives from the original
			// semantic references. A detached predicate added here cannot
			// reliably retain an alias that was used only as a type, so reject
			// every imported root rather than risk a dangling constructor name.
			if current.Kind == shimast.KindImportClause {
				return false
			}
		}
	}
	return true
}

// qualifiedValueExpr accepts the identifier/property-access form produced by
// the checker for ordinary class values. If naming the constructor would need
// a synthetic import or another expression form, the class guard is skipped.
func qualifiedValueExpr(factory *shimast.NodeFactory, name string) (*shimast.Expression, bool) {
	parts := strings.Split(name, ".")
	if len(parts) == 0 || !isIdentifierSegment(parts[0]) {
		return nil, false
	}
	var out *shimast.Expression = factory.NewIdentifier(parts[0])
	for _, part := range parts[1:] {
		if !isIdentifierSegment(part) {
			return nil, false
		}
		out = factory.NewPropertyAccessExpression(out, nil, factory.NewIdentifier(part), 0)
	}
	return out, true
}

func isRuntimeProperty(sym *shimast.Symbol, seen map[string]bool) bool {
	if sym == nil || strings.HasPrefix(sym.Name, "\xFE") || seen[sym.Name] {
		return false
	}
	seen[sym.Name] = true
	return true
}

// stringIndexValueType accepts exactly one string index. Number and symbol
// indexes are skipped as a whole because Object.keys cannot enforce their
// distinct value semantics soundly.
func stringIndexValueType(checker *shimchecker.Checker, t *shimchecker.Type) (*shimchecker.Type, bool, bool) {
	var valueType *shimchecker.Type
	for _, info := range shimchecker.Checker_getIndexInfosOfType(checker, t) {
		if info == nil || info.KeyType() == nil || info.KeyType().Flags()&shimchecker.TypeFlagsString == 0 || valueType != nil {
			return nil, false, false
		}
		valueType = info.ValueType()
		if valueType == nil {
			return nil, false, false
		}
	}
	return valueType, valueType != nil, true
}

func stringIndexInvalidPredicate(
	factory *shimast.NodeFactory,
	checker *shimchecker.Checker,
	enclosing *shimast.Node,
	path string,
	valueType *shimchecker.Type,
	state *predicateState,
	depth int,
) (*shimast.Expression, bool) {
	keyName := state.freshIdentifier("__di_key")
	valueInvalid, ok := invalidPredicate(factory, checker, enclosing, path+"["+keyName+"]", valueType, state, depth+1)
	if !ok {
		return nil, false
	}
	keys := factory.NewCallExpression(
		factory.NewPropertyAccessExpression(factory.NewIdentifier("Object"), nil, factory.NewIdentifier("keys"), 0),
		nil, nil, factory.NewNodeList([]*shimast.Node{pathExpr(factory, path)}), 0,
	)
	param := factory.NewParameterDeclaration(nil, nil, factory.NewIdentifier(keyName), nil, nil, nil)
	arrow := factory.NewArrowFunction(nil, nil, factory.NewNodeList([]*shimast.Node{param}), nil, nil, factory.NewToken(shimast.KindEqualsGreaterThanToken), valueInvalid)
	return factory.NewCallExpression(
		factory.NewPropertyAccessExpression(keys, nil, factory.NewIdentifier("some"), 0),
		nil, nil, factory.NewNodeList([]*shimast.Node{arrow}), 0,
	), true
}

func isIdentifierSegment(value string) bool {
	if value == "" {
		return false
	}
	for i, r := range value {
		if i == 0 {
			if r != '_' && r != '$' && !unicode.IsLetter(r) {
				return false
			}
			continue
		}
		if r != '_' && r != '$' && !unicode.IsLetter(r) && !unicode.IsDigit(r) && !unicode.IsMark(r) {
			return false
		}
	}
	return true
}

func tupleInvalidPredicate(
	factory *shimast.NodeFactory,
	checker *shimchecker.Checker,
	enclosing *shimast.Node,
	path string,
	t *shimchecker.Type,
	state *predicateState,
	depth int,
) (*shimast.Expression, bool) {
	elements := checker.GetTypeArguments(t)
	flags := t.TargetTupleType().ElementFlags()
	if len(elements) != len(flags) {
		return nil, false
	}
	minLength := 0
	for _, flag := range flags {
		if flag&shimchecker.ElementFlagsRest != 0 {
			return nil, false
		}
		if flag&shimchecker.ElementFlagsRequired != 0 {
			minLength++
		}
	}
	isArray := factory.NewCallExpression(
		factory.NewPropertyAccessExpression(factory.NewIdentifier("Array"), nil, factory.NewIdentifier("isArray"), 0),
		nil, nil, factory.NewNodeList([]*shimast.Node{pathExpr(factory, path)}), 0,
	)
	out := factory.NewPrefixUnaryExpression(shimast.KindExclamationToken, isArray)
	lengthPath := path + ".length"
	if minLength == len(elements) {
		badLength := binary(factory, pathExpr(factory, lengthPath), shimast.KindExclamationEqualsEqualsToken, factory.NewNumericLiteral(fmt.Sprint(len(elements)), shimast.TokenFlagsNone))
		out = binary(factory, out, shimast.KindBarBarToken, badLength)
	} else {
		tooShort := binary(factory, pathExpr(factory, lengthPath), shimast.KindLessThanToken, factory.NewNumericLiteral(fmt.Sprint(minLength), shimast.TokenFlagsNone))
		tooLong := binary(factory, pathExpr(factory, lengthPath), shimast.KindGreaterThanToken, factory.NewNumericLiteral(fmt.Sprint(len(elements)), shimast.TokenFlagsNone))
		out = binary(factory, out, shimast.KindBarBarToken, binary(factory, tooShort, shimast.KindBarBarToken, tooLong))
	}
	for i, element := range elements {
		pred, ok := invalidPredicate(factory, checker, enclosing, fmt.Sprintf("%s[%d]", path, i), element, state, depth+1)
		if !ok {
			return nil, false
		}
		if flags[i]&shimchecker.ElementFlagsOptional != 0 {
			present := binary(factory, pathExpr(factory, lengthPath), shimast.KindGreaterThanToken, factory.NewNumericLiteral(fmt.Sprint(i), shimast.TokenFlagsNone))
			pred = binary(factory, present, shimast.KindAmpersandAmpersandToken, pred)
		}
		out = binary(factory, out, shimast.KindBarBarToken, pred)
	}
	return out, true
}

func arrayInvalidPredicate(
	factory *shimast.NodeFactory,
	checker *shimchecker.Checker,
	enclosing *shimast.Node,
	path string,
	t *shimchecker.Type,
	state *predicateState,
	depth int,
) (*shimast.Expression, bool) {
	typeArgs := checker.GetTypeArguments(t)
	if len(typeArgs) != 1 {
		return nil, false
	}
	itemName := state.freshIdentifier("__di_item")
	itemInvalid, ok := invalidPredicate(factory, checker, enclosing, itemName, typeArgs[0], state, depth+1)
	if !ok {
		return nil, false
	}
	isArray := factory.NewCallExpression(
		factory.NewPropertyAccessExpression(factory.NewIdentifier("Array"), nil, factory.NewIdentifier("isArray"), 0),
		nil, nil, factory.NewNodeList([]*shimast.Node{pathExpr(factory, path)}), 0,
	)
	notArray := factory.NewPrefixUnaryExpression(shimast.KindExclamationToken, isArray)
	param := factory.NewParameterDeclaration(nil, nil, factory.NewIdentifier(itemName), nil, nil, nil)
	arrow := factory.NewArrowFunction(nil, nil, factory.NewNodeList([]*shimast.Node{param}), nil, nil, factory.NewToken(shimast.KindEqualsGreaterThanToken), itemInvalid)
	hasInvalidItem := factory.NewCallExpression(
		factory.NewPropertyAccessExpression(pathExpr(factory, path), nil, factory.NewIdentifier("some"), 0),
		nil, nil, factory.NewNodeList([]*shimast.Node{arrow}), 0,
	)
	return binary(factory, notArray, shimast.KindBarBarToken, hasInvalidItem), true
}

func equalityCheck(factory *shimast.NodeFactory, path string, expected *shimast.Expression, label string) *shimast.Node {
	cond := binary(factory, pathExpr(factory, path), shimast.KindExclamationEqualsEqualsToken, expected)
	return throwIf(factory, cond, "Expected "+path+" to equal "+label)
}

func requiredPropertyCheck(factory *shimast.NodeFactory, path, property string) *shimast.Node {
	return throwIf(factory, missingPropertyPredicate(factory, path, property), "Expected "+path+" to have required property "+strconv.Quote(property))
}

func missingPropertyPredicate(factory *shimast.NodeFactory, path, property string) *shimast.Expression {
	present := binary(
		factory,
		factory.NewStringLiteral(property, shimast.TokenFlagsNone),
		shimast.KindInKeyword,
		pathExpr(factory, path),
	)
	return factory.NewPrefixUnaryExpression(shimast.KindExclamationToken, present)
}

func propertyPath(path, property string) string {
	if isSimpleIdentifier(property) {
		return path + "." + property
	}
	return path + "[" + strconv.Quote(property) + "]"
}

func isSimpleIdentifier(value string) bool {
	if value == "" {
		return false
	}
	for i, r := range value {
		if !(r == '_' || r == '$' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || i > 0 && r >= '0' && r <= '9') {
			return false
		}
	}
	return true
}

// pathExpr builds a fresh expression tree for a dotted path (e.g. "user.id").
// Each call allocates new nodes — AST nodes are not shareable across parents.
func pathExpr(factory *shimast.NodeFactory, path string) *shimast.Expression {
	end := strings.IndexAny(path, ".[")
	if end < 0 {
		return factory.NewIdentifier(path)
	}
	var expr *shimast.Expression = factory.NewIdentifier(path[:end])
	for end < len(path) {
		if path[end] == '.' {
			start := end + 1
			end = start
			for end < len(path) && path[end] != '.' && path[end] != '[' {
				end++
			}
			expr = factory.NewPropertyAccessExpression(expr, nil, factory.NewIdentifier(path[start:end]), 0)
			continue
		}
		start := end + 1
		if start < len(path) && path[start] == '"' {
			quotedEnd := start + 1
			escaped := false
			for quotedEnd < len(path) {
				if path[quotedEnd] == '"' && !escaped {
					break
				}
				if path[quotedEnd] == '\\' {
					escaped = !escaped
				} else {
					escaped = false
				}
				quotedEnd++
			}
			if quotedEnd >= len(path) || quotedEnd+1 >= len(path) || path[quotedEnd+1] != ']' {
				return expr
			}
			property, err := strconv.Unquote(path[start : quotedEnd+1])
			if err != nil {
				return expr
			}
			expr = factory.NewElementAccessExpression(expr, nil, factory.NewStringLiteral(property, shimast.TokenFlagsNone), 0)
			end = quotedEnd + 2
			continue
		}
		close := strings.IndexByte(path[start:], ']')
		if close < 0 {
			return expr
		}
		close += start
		index := path[start:close]
		// An identifier-shaped synthesized index prints as the numeric token while
		// avoiding the emitter asking source-text questions of a detached literal.
		expr = factory.NewElementAccessExpression(expr, nil, factory.NewIdentifier(index), 0)
		end = close + 1
	}
	return expr
}

func typeofCheck(factory *shimast.NodeFactory, path, kind string) *shimast.Node {
	cond := binary(
		factory,
		factory.NewTypeOfExpression(pathExpr(factory, path)),
		shimast.KindExclamationEqualsEqualsToken,
		factory.NewStringLiteral(kind, shimast.TokenFlagsNone),
	)
	return throwIf(factory, cond, "Expected "+path+" to be a "+kind)
}

func objectCheck(factory *shimast.NodeFactory, path string) *shimast.Node {
	notObject := binary(
		factory,
		factory.NewTypeOfExpression(pathExpr(factory, path)),
		shimast.KindExclamationEqualsEqualsToken,
		factory.NewStringLiteral("object", shimast.TokenFlagsNone),
	)
	isNull := binary(
		factory,
		pathExpr(factory, path),
		shimast.KindEqualsEqualsEqualsToken,
		factory.NewToken(shimast.KindNullKeyword),
	)
	cond := binary(factory, notObject, shimast.KindBarBarToken, isNull)
	return throwIf(factory, cond, "Expected "+path+" to be an object")
}

func throwIf(factory *shimast.NodeFactory, condition *shimast.Expression, message string) *shimast.Node {
	msg := factory.NewStringLiteral(message, shimast.TokenFlagsNone)
	ctor := factory.NewIdentifier("TypeError")
	args := factory.NewNodeList([]*shimast.Node{msg})
	newExpr := factory.NewNewExpression(ctor, nil, args)
	throwStmt := factory.NewThrowStatement(newExpr)
	return factory.NewIfStatement(condition, throwStmt, nil)
}

func binary(
	factory *shimast.NodeFactory,
	left *shimast.Expression,
	op shimast.Kind,
	right *shimast.Expression,
) *shimast.Expression {
	return factory.NewBinaryExpression(
		nil,
		left,
		nil,
		factory.NewToken(op),
		right,
	)
}

func parseOptions(command string, args []string) (options, bool) {
	fs := flag.NewFlagSet(command, flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	cwd := fs.String("cwd", "", "project directory")
	emit := fs.Bool("emit", false, "force emit")
	noEmit := fs.Bool("noEmit", false, "force no emit")
	outDir := fs.String("outDir", "", "emit directory override")
	tsconfig := fs.String("tsconfig", "tsconfig.json", "project tsconfig")
	_ = fs.String("plugins-json", "", "ttsc plugin metadata")
	_ = fs.Bool("quiet", true, "suppress summary")
	_ = fs.Bool("verbose", false, "print summary")
	if err := fs.Parse(filterHostArgs(args, fs)); err != nil {
		return options{}, false
	}
	root := *cwd
	if root == "" {
		var err error
		root, err = os.Getwd()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return options{}, false
		}
	}
	if !filepath.IsAbs(root) {
		abs, err := filepath.Abs(root)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return options{}, false
		}
		root = abs
	}
	cfg := *tsconfig
	if !filepath.IsAbs(cfg) {
		cfg = filepath.Join(root, cfg)
	}
	return options{
		cwd:      filepath.Clean(root),
		emit:     *emit,
		noEmit:   *noEmit,
		outDir:   *outDir,
		tsconfig: cfg,
	}, true
}

var valueFlags = map[string]bool{
	"--cwd":          true,
	"--tsconfig":     true,
	"--outDir":       true,
	"--plugins-json": true,
}

func filterHostArgs(args []string, fs *flag.FlagSet) []string {
	out := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		a := args[i]
		if !strings.HasPrefix(a, "-") {
			out = append(out, a)
			continue
		}
		name, _, hasEq := strings.Cut(a, "=")
		if fs.Lookup(strings.TrimLeft(name, "-")) != nil {
			out = append(out, a)
			if !hasEq && valueFlags[name] && i+1 < len(args) {
				out = append(out, args[i+1])
				i++
			}
			continue
		}
		if !hasEq && valueFlags[name] && i+1 < len(args) {
			i++
		}
	}
	return out
}

func outputKey(cwd, fileName string) string {
	rel, err := filepath.Rel(cwd, fileName)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return filepath.ToSlash(fileName)
	}
	return filepath.ToSlash(rel)
}
