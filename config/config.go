package config

import (
	"os"

	"github.com/pelletier/go-toml/v2"
)

type ServerConfig struct {
	BindAddress      string `toml:"bind_address"`
	Port             int    `toml:"port"`
	MaxHistoryWindow int    `toml:"max_history_window"`
	EngineMode       string `toml:"engine_mode"`
}

type ThresholdsConfig struct {
	ConsecutiveFailuresLimit int     `toml:"consecutive_failures_limit"`
	CommandSimilarityCutoff  float64 `toml:"command_similarity_cutoff"`
	GitDiffSimilarityCutoff  float64 `toml:"git_diff_similarity_cutoff"`
	ErrorSimilarityCutoff    float64 `toml:"error_similarity_cutoff"`
}

type NormalizationConfig struct {
	CustomStripRegex []string `toml:"custom_strip_regex"`
}

type ActionsConfig struct {
	OnTrip                 string `toml:"on_trip"`
	SendSystemNotification bool   `toml:"send_system_notification"`
	DiagnosticLogPath      string `toml:"diagnostic_log_path"`
}

type Config struct {
	Server        ServerConfig        `toml:"server"`
	Thresholds    ThresholdsConfig    `toml:"thresholds"`
	Normalization NormalizationConfig `toml:"normalization"`
	Actions       ActionsConfig       `toml:"actions"`
}

func DefaultConfig() *Config {
	return &Config{
		Server: ServerConfig{
			BindAddress:      "127.0.0.1",
			Port:             8089,
			MaxHistoryWindow: 5,
			EngineMode:       "hybrid",
		},
		Thresholds: ThresholdsConfig{
			ConsecutiveFailuresLimit: 3,
			CommandSimilarityCutoff:  0.95,
			GitDiffSimilarityCutoff:  0.98,
			ErrorSimilarityCutoff:    0.90,
		},
		Normalization: NormalizationConfig{
			CustomStripRegex: []string{
				"Time elapsed:\\s*\\d+\\.\\d+s",
				"0x[a-fA-F0-9]+",
				"Finished in \\d+ms",
				"ContainerID:\\s*[a-zA-Z0-9]+",
			},
		},
		Actions: ActionsConfig{
			OnTrip:                 "kill_process",
			SendSystemNotification: true,
			DiagnosticLogPath:      ".brakes/logs/",
		},
	}
}

func LoadConfig(path string) (*Config, error) {
	config := DefaultConfig()

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			// Return default config if file doesn't exist
			return config, nil
		}
		return nil, err
	}

	err = toml.Unmarshal(data, config)
	if err != nil {
		// Fallback to default if there is an unmarshal error
		return DefaultConfig(), nil
	}

	return config, nil
}
