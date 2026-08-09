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
	"strings"

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
		if node.Kind == shimast.KindFunctionDeclaration {
			injectFunction(factory, checker, node)
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

func injectFunction(factory *shimast.NodeFactory, checker *shimchecker.Checker, node *shimast.Node) {
	fn := node.AsFunctionDeclaration()
	if fn == nil || fn.Body == nil || fn.Parameters == nil {
		return
	}
	block := fn.Body.AsBlock()
	if block == nil || block.Statements == nil {
		return
	}

	var checks []*shimast.Node
	for _, param := range fn.Parameters.Nodes {
		if param == nil || param.Kind != shimast.KindParameter {
			continue
		}
		p := param.AsParameterDeclaration()
		if p == nil || p.Name() == nil || p.Name().Kind != shimast.KindIdentifier {
			continue
		}
		if p.DotDotDotToken != nil || p.QuestionToken != nil || p.Initializer != nil {
			continue
		}
		name := p.Name().Text()
		checks = append(checks, checksForParam(factory, checker, param, name)...)
	}
	if len(checks) == 0 {
		return
	}

	// Structural prepend — printer walks Statements.Nodes directly.
	out := make([]*shimast.Node, 0, len(checks)+len(block.Statements.Nodes))
	out = append(out, checks...)
	out = append(out, block.Statements.Nodes...)
	block.Statements.Nodes = out
	// Emit walks parents; factory nodes start detached.
	shimast.SetParentInChildren(fn.Body)
}

func checksForParam(
	factory *shimast.NodeFactory,
	checker *shimchecker.Checker,
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
	return stmtsFromCheckerType(factory, checker, path, t)
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
	path string,
	t *shimchecker.Type,
) []*shimast.Node {
	return stmtsFromCheckerTypeSeen(factory, checker, path, t, make(map[*shimchecker.Type]bool), 0)
}

func stmtsFromCheckerTypeSeen(
	factory *shimast.NodeFactory,
	checker *shimchecker.Checker,
	path string,
	t *shimchecker.Type,
	seen map[*shimchecker.Type]bool,
	depth int,
) []*shimast.Node {
	// Platform and application interfaces can be recursive. Runtime guards are
	// deliberately bounded so a cyclic type graph cannot make compilation hang.
	if depth > 8 || seen[t] {
		return nil
	}
	flags := t.Flags()
	switch {
	case flags&shimchecker.TypeFlagsString != 0:
		return []*shimast.Node{typeofCheck(factory, path, "string")}
	case flags&shimchecker.TypeFlagsNumber != 0:
		return []*shimast.Node{typeofCheck(factory, path, "number")}
	case flags&shimchecker.TypeFlagsBoolean != 0:
		return []*shimast.Node{typeofCheck(factory, path, "boolean")}
	case flags&shimchecker.TypeFlagsBigInt != 0:
		return []*shimast.Node{typeofCheck(factory, path, "bigint")}
	case flags&shimchecker.TypeFlagsObject != 0:
		seen[t] = true
		defer delete(seen, t)
		props := shimchecker.Checker_getApparentProperties(checker, t)
		if len(props) == 0 {
			return nil
		}
		out := []*shimast.Node{objectCheck(factory, path)}
		for _, sym := range props {
			if sym == nil {
				continue
			}
			propName := sym.Name
			if propName == "" || strings.HasPrefix(propName, "__") {
				continue
			}
			if sym.Flags&shimast.SymbolFlagsOptional != 0 {
				continue
			}
			propType := shimchecker.Checker_getTypeOfPropertyOfType(checker, t, propName)
			if propType == nil {
				continue
			}
			out = append(out, stmtsFromCheckerTypeSeen(
				factory,
				checker,
				path+"."+propName,
				propType,
				seen,
				depth+1,
			)...)
		}
		return out
	default:
		return nil
	}
}

// pathExpr builds a fresh expression tree for a dotted path (e.g. "user.id").
// Each call allocates new nodes — AST nodes are not shareable across parents.
func pathExpr(factory *shimast.NodeFactory, path string) *shimast.Expression {
	parts := strings.Split(path, ".")
	var expr *shimast.Expression = factory.NewIdentifier(parts[0])
	for _, part := range parts[1:] {
		expr = factory.NewPropertyAccessExpression(
			expr,
			nil,
			factory.NewIdentifier(part),
			0,
		)
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
