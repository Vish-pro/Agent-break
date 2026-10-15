package engine

import (
	"regexp"
)

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// Levenshtein distance
func levenshtein(s1, s2 string) int {
	r1, r2 := []rune(s1), []rune(s2)
	len1, len2 := len(r1), len(r2)

	if len1 == 0 {
		return len2
	}
	if len2 == 0 {
		return len1
	}

	d := make([][]int, len1+1)
	for i := range d {
		d[i] = make([]int, len2+1)
		d[i][0] = i
	}
	for j := 0; j <= len2; j++ {
		d[0][j] = j
	}

	for i := 1; i <= len1; i++ {
		for j := 1; j <= len2; j++ {
			cost := 1
			if r1[i-1] == r2[j-1] {
				cost = 0
			}
			d[i][j] = min(
				d[i-1][j]+1,      // deletion
				min(
					d[i][j-1]+1,      // insertion
					d[i-1][j-1]+cost, // substitution
				),
			)
		}
	}
	return d[len1][len2]
}

// NormalizedLevenshtein returns a float between 0.0 and 1.0 representing similarity
func NormalizedLevenshtein(s1, s2 string) float64 {
	maxLength := max(len([]rune(s1)), len([]rune(s2)))
	if maxLength == 0 {
		return 1.0 // both strings are empty
	}
	lev := levenshtein(s1, s2)
	return 1.0 - (float64(lev) / float64(maxLength))
}

var tokenSplitter = regexp.MustCompile(`[\s\[\]{}()<>.,;:'"!?\-+*/=|&^%#@~\\]+`)

// tokenize splits a string into tokens based on whitespaces, brackets, punctuation, and arrows.
func tokenize(text string) map[string]struct{} {
	// Let's replace arrows specifically to spaces to ensure they are split boundaries
	text = regexp.MustCompile(`(->|=>)`).ReplaceAllString(text, " ")
	tokens := tokenSplitter.Split(text, -1)

	tokenSet := make(map[string]struct{})
	for _, t := range tokens {
		if t != "" {
			tokenSet[t] = struct{}{}
		}
	}
	return tokenSet
}

// JaccardSimilarity calculates Jaccard index for texts
func JaccardSimilarity(s1, s2 string) float64 {
	setA := tokenize(s1)
	setB := tokenize(s2)

	if len(setA) == 0 && len(setB) == 0 {
		return 1.0 // both are empty, effectively similar
	}

	intersection := 0
	for token := range setA {
		if _, exists := setB[token]; exists {
			intersection++
		}
	}

	union := len(setA) + len(setB) - intersection

	if union == 0 {
		return 1.0 // safeguard, shouldn't reach here if not both empty
	}

	return float64(intersection) / float64(union)
}
