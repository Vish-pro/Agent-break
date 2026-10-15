package engine

import (
	"regexp"
	"strings"
)

var (
	// 1. Timestamp Removal
	timeRegex = regexp.MustCompile(`(?i)(finished in|elapsed|duration:?)\s*\d+(\.\d+)?\s*(s|ms|seconds)`)

	// 2. Memory Allocation & Memory Address Erasure
	memAllocRegex = regexp.MustCompile(`0x[0-9a-fA-F]+`)

	// 3. Ephemeral Network/Port Variables
	netPortRegex = regexp.MustCompile(`(localhost|127\.0\.0\.1):\d+`)
)

type Normalizer struct {
	customRegexes []*regexp.Regexp
}

func NewNormalizer(customStripRegex []string) *Normalizer {
	n := &Normalizer{
		customRegexes: make([]*regexp.Regexp, 0, len(customStripRegex)),
	}
	for _, pattern := range customStripRegex {
		r, err := regexp.Compile(pattern)
		if err == nil {
			n.customRegexes = append(n.customRegexes, r)
		}
	}
	return n
}

func (n *Normalizer) Normalize(text string, workspaceDir string) string {
	// Apply default regexes
	text = timeRegex.ReplaceAllString(text, "[TIME]")
	text = memAllocRegex.ReplaceAllString(text, "[MEM]")
	text = netPortRegex.ReplaceAllString(text, "[ADDR]:[PORT]")

	// Apply custom regexes from config
	for _, r := range n.customRegexes {
		text = r.ReplaceAllString(text, "[STRIPPED]")
	}

	// 4. Absolute Path Canonicalization
	if workspaceDir != "" {
		// Ensure workspaceDir ends with separator if it's not root, but simple replace is fine for absolute to relative
		// Assuming workspaceDir like "/workspace" or "/Users/dev/projects/app"
		if !strings.HasSuffix(workspaceDir, "/") {
			text = strings.ReplaceAll(text, workspaceDir+"/", "./")
			text = strings.ReplaceAll(text, workspaceDir, ".")
		} else {
			text = strings.ReplaceAll(text, workspaceDir, "./")
		}
	}

	return text
}
