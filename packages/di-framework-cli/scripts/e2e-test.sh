#!/bin/bash

# End-to-End Test Script for DI Framework
# Tests the entire project including compilation, unit tests, and example validation

echo "================================"
echo "DI Framework E2E Test Suite"
echo "================================"
echo ""

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test counter
TESTS_PASSED=0
TESTS_FAILED=0

# Function to print test status
print_test() {
  echo -e "${YELLOW}▶ $1${NC}"
}

print_success() {
  echo -e "${GREEN}✓ $1${NC}"
  ((TESTS_PASSED++))
}

print_error() {
  echo -e "${RED}✗ $1${NC}"
  ((TESTS_FAILED++))
}

# 1. Check dependencies
print_test "Checking environment..."
if ! type bun > /dev/null 2>&1; then
  print_error "Bun is not installed. Please install Bun: https://bun.sh"
  exit 1
fi
print_success "Bun is installed"

if ! type node > /dev/null 2>&1; then
  print_error "Node.js is not installed. Please install Node.js"
  exit 1
fi
print_success "Node.js is installed"

echo ""

# 2. Install dependencies
print_test "Installing dependencies..."
if bun install --frozen-lockfile 2>/dev/null || bun install; then
  print_success "Dependencies installed"
else
  print_error "Failed to install dependencies"
  exit 1
fi

echo ""

# 3. TypeScript type checking (per-package)
print_test "Running TypeScript type checks..."
if npx tsc --noEmit -p packages/di-framework/tsconfig.json 2>/dev/null; then
  print_success "di-framework type checks passed"
else
  print_error "di-framework type checks failed"
  npx tsc --noEmit -p packages/di-framework/tsconfig.json 2>&1 | head -20
  exit 1
fi

echo ""

# 4. Run framework tests
print_test "Running tests..."
if (bun test:all); then
  print_success "Tests passed"
else
  print_error "Tests failed"
  exit 1
fi

echo ""

# 5. Validate examples compile
print_test "Validating example code..."
if npx tsc --noEmit -p packages/examples/tsconfig.json 2>/dev/null; then
  print_success "Advanced example validated"
else
  print_error "Advanced example has type errors"
fi

echo ""

# 6. Check if examples package is properly structured
print_test "Checking examples package structure..."
if [ -f "packages/examples/package.json" ]; then
  print_success "Examples package.json found"
else
  print_error "Examples package.json not found"
fi

echo ""

# Summary
echo "================================"
echo "Test Summary"
echo "================================"
echo -e "${GREEN}Passed: $TESTS_PASSED${NC}"
if [ $TESTS_FAILED -gt 0 ]; then
  echo -e "${RED}Failed: $TESTS_FAILED${NC}"
  exit 1
else
  echo -e "${GREEN}Failed: 0${NC}"
  echo ""
  echo -e "${GREEN}All tests passed! ✓${NC}"
  exit 0
fi