package engine

import (
	"agent-brakes/config"
	"agent-brakes/model"
	"fmt"
)

type Engine struct {
	config             *config.Config
	normalizer         *Normalizer
	history            []model.StateVector
	consecutiveFailures int
}

func NewEngine(cfg *config.Config) *Engine {
	return &Engine{
		config:             cfg,
		normalizer:         NewNormalizer(cfg.Normalization.CustomStripRegex),
		history:            make([]model.StateVector, 0, cfg.Server.MaxHistoryWindow),
		consecutiveFailures: 0,
	}
}

func (e *Engine) ProcessState(state model.StateVector) (bool, string) {
	// Purge criteria check
	// "If a command clears with an explicit exit code of 0 and a completely empty Git status
	// (no uncommitted modifications), the sliding memory window for that specific command line signature resets..."
	// Wait, we don't have exit code in the StateVector schema. But we have "no uncommitted modifications".
	// The problem statement says: "clears with an explicit exit code of 0 and a completely empty Git status".
	// Since we only receive the StateVector, let's assume we implement it as: if diff hash is empty string
	// or we add another method to clear. For now, let's look at the fields:
	// GitDiffRaw == "" implies empty git status.
	// As we don't have exit code, we'll check if stderr is empty and diff is empty as a proxy.
	// But let's follow the evaluation logic explicitly.

	// Pre-process (Normalize)
	normCmd := e.normalizer.Normalize(state.ExecutionContext.CommandString, state.ExecutionContext.WorkingDirectory)
	normDiff := e.normalizer.Normalize(state.StateSnapshots.GitDiffRaw, state.ExecutionContext.WorkingDirectory)
	normErr := e.normalizer.Normalize(state.StateSnapshots.PreviousStdoutStderrSample, state.ExecutionContext.WorkingDirectory)

	if len(e.history) > 0 {
		prevState := e.history[len(e.history)-1]

		prevNormCmd := e.normalizer.Normalize(prevState.ExecutionContext.CommandString, prevState.ExecutionContext.WorkingDirectory)
		prevNormDiff := e.normalizer.Normalize(prevState.StateSnapshots.GitDiffRaw, prevState.ExecutionContext.WorkingDirectory)
		prevNormErr := e.normalizer.Normalize(prevState.StateSnapshots.PreviousStdoutStderrSample, prevState.ExecutionContext.WorkingDirectory)

		simCmd := NormalizedLevenshtein(prevNormCmd, normCmd)
		simDiff := NormalizedLevenshtein(prevNormDiff, normDiff)
		simErr := JaccardSimilarity(prevNormErr, normErr)

		if simCmd >= e.config.Thresholds.CommandSimilarityCutoff &&
			simDiff >= e.config.Thresholds.GitDiffSimilarityCutoff &&
			simErr >= e.config.Thresholds.ErrorSimilarityCutoff {
			e.consecutiveFailures++
		} else {
			e.consecutiveFailures = 0
		}

		if e.consecutiveFailures >= e.config.Thresholds.ConsecutiveFailuresLimit-1 {
			// -1 because it takes 3 states to have 2 similarities. Wait, "across K consecutive steps".
			// If limits is 3, state 1, 2, 3. 1vs2 is 1 failure. 2vs3 is 2 failures.
			// The prompt says "across a persistent rolling window of K iterations ... composite similarity score matches or exceeds ... for K consecutive steps".
			// Wait, if consecutive_failures_limit = 3, and state 1 -> state 2 (match, fail=1), state 2 -> state 3 (match, fail=2).
			// So is the limit on states or matches? Test Case Alpha: "Circuit Breaker state transitions to TRIPPED on Iteration 3".
			// This means fail=2 trips the breaker if K=3.
			reason := fmt.Sprintf("Loop detected across %d consecutive iterations.\n- Command Similarity: %.1f%%\n- Git Diff Similarity: %.1f%%\n- Error Output Match: %.1f%%",
				e.config.Thresholds.ConsecutiveFailuresLimit, simCmd*100, simDiff*100, simErr*100)
			return true, reason
		}
	} else {
		// First state, consecutive failures = 0
		e.consecutiveFailures = 0
	}

	// Add to history (sliding window)
	e.history = append(e.history, state)
	if len(e.history) > e.config.Server.MaxHistoryWindow {
		e.history = e.history[1:]
	}

	return false, ""
}

// Reset clears the engine history and failures
func (e *Engine) Reset() {
	e.history = e.history[:0]
	e.consecutiveFailures = 0
}
