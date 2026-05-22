package model

type ExecutionContext struct {
	WorkingDirectory string `json:"working_directory"`
	CommandString    string `json:"command_string"`
}

type StateSnapshots struct {
	GitDiffHash                 string `json:"git_diff_hash"`
	GitDiffRaw                  string `json:"git_diff_raw"`
	PreviousStdoutStderrSample  string `json:"previous_stdout_stderr_sample"`
}

type StateVector struct {
	Timestamp        int64            `json:"timestamp"`
	IterationIndex   int              `json:"iteration_index"`
	ExecutionContext ExecutionContext `json:"execution_context"`
	StateSnapshots   StateSnapshots   `json:"state_snapshots"`
}
