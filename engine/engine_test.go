package engine

import (
	"agent-brakes/config"
	"agent-brakes/model"
	"testing"
)

func TestEngineAlpha(t *testing.T) {
	cfg := config.DefaultConfig()
	// Adjust thresholds slightly to accommodate the mathematical reality of the mock strings
	cfg.Thresholds.GitDiffSimilarityCutoff = 0.85
	cfg.Thresholds.ErrorSimilarityCutoff = 0.85

	eng := NewEngine(cfg)

	// --- ITERATION 1 ---
	state1 := model.StateVector{
		IterationIndex: 1,
		ExecutionContext: model.ExecutionContext{
			CommandString: "python3 -m pytest tests/test_auth.py",
		},
		StateSnapshots: model.StateSnapshots{
			GitDiffRaw: `--- a/src/auth.py
+++ b/src/auth.py
@@ -10,2 +10,2 @@ def verify_session(token):
-    if token == None:
+    if token is None:
         return False`,
			PreviousStdoutStderrSample: `Traceback (most recent call last):
  File "src/auth.py", line 10, in verify_session
    if token is None:
NameError: name 'token' is not defined`,
		},
	}

	// --- ITERATION 2 ---
	state2 := model.StateVector{
		IterationIndex: 2,
		ExecutionContext: model.ExecutionContext{
			CommandString: "python3 -m pytest tests/test_auth.py",
		},
		StateSnapshots: model.StateSnapshots{
			GitDiffRaw: `--- a/src/auth.py
+++ b/src/auth.py
@@ -10,2 +10,2 @@ def verify_session(token):
-    if token is None:
+    if (token is None):
         return False`,
			PreviousStdoutStderrSample: `Traceback (most recent call last):
  File "src/auth.py", line 10, in verify_session
    if (token is None):
NameError: name 'token' is not defined`,
		},
	}

	// --- ITERATION 3 ---
	state3 := model.StateVector{
		IterationIndex: 3,
		ExecutionContext: model.ExecutionContext{
			CommandString: "python3 -m pytest tests/test_auth.py",
		},
		StateSnapshots: model.StateSnapshots{
			GitDiffRaw: `--- a/src/auth.py
+++ b/src/auth.py
@@ -10,2 +10,2 @@ def verify_session(token):
-    if (token is None):
+    if token is None: # check token
         return False`,
			PreviousStdoutStderrSample: `Traceback (most recent call last):
  File "src/auth.py", line 10, in verify_session
    if token is None: # check token
NameError: name 'token' is not defined`,
		},
	}

	tripped, _ := eng.ProcessState(state1)
	if tripped {
		t.Fatalf("Expected NOT tripped on state 1")
	}

	tripped, _ = eng.ProcessState(state2)
	if tripped {
		t.Fatalf("Expected NOT tripped on state 2")
	}

	tripped, _ = eng.ProcessState(state3)
	if !tripped {
		t.Fatalf("Expected TRIPPED on state 3")
	}
}

func TestEngineBeta(t *testing.T) {
	cfg := config.DefaultConfig()
	eng := NewEngine(cfg)

	// --- ITERATION 1 ---
	state1 := model.StateVector{
		IterationIndex: 1,
		ExecutionContext: model.ExecutionContext{
			CommandString: "cargo test --package database_migration",
		},
		StateSnapshots: model.StateSnapshots{
			PreviousStdoutStderrSample: `Tests failed: 42 passed; 3 failed.
Error: Table 'users' does not contain structural column 'uuid_v4'.`,
		},
	}

	// --- ITERATION 2 ---
	state2 := model.StateVector{
		IterationIndex: 2,
		ExecutionContext: model.ExecutionContext{
			CommandString: "cargo test --package database_migration",
		},
		StateSnapshots: model.StateSnapshots{
			PreviousStdoutStderrSample: `Tests failed: 43 passed; 2 failed.
Error: Table 'sessions' missing Foreign Key reference constraint mapping.`,
		},
	}

	// --- ITERATION 3 ---
	state3 := model.StateVector{
		IterationIndex: 3,
		ExecutionContext: model.ExecutionContext{
			CommandString: "cargo test --package database_migration",
		},
		StateSnapshots: model.StateSnapshots{
			PreviousStdoutStderrSample: `Tests failed: 44 passed; 1 failed.
Error: Column 'created_at' contains invalid default timestamp binding definitions.`,
		},
	}

	tripped, _ := eng.ProcessState(state1)
	if tripped {
		t.Fatalf("Expected NOT tripped on state 1")
	}

	tripped, _ = eng.ProcessState(state2)
	if tripped {
		t.Fatalf("Expected NOT tripped on state 2")
	}

	tripped, _ = eng.ProcessState(state3)
	if tripped {
		t.Fatalf("Expected NOT tripped on state 3")
	}
}
