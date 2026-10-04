package dotenv

import (
	"reflect"
	"testing"
)

func TestParse(t *testing.T) {
	text := "# comment\nexport A=1\nB = two words # note\nC=\"line1\\nline2 \\\"q\\\"\"\nD='keep ${X} \\n'\nE=\"multi\nline\"\nF=\n"
	got, err := Parse(text)
	if err != nil {
		t.Fatal(err)
	}
	want := []Var{{"A", "1"}, {"B", "two words"}, {"C", "line1\nline2 \"q\""}, {"D", `keep ${X} \n`}, {"E", "multi\nline"}, {"F", ""}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q", got)
	}
	if _, err := Parse("not a pair"); err == nil {
		t.Fatal("a line without = is an error")
	}
	if _, err := Parse("A=\"open"); err == nil {
		t.Fatal("an open quote is an error")
	}
}

func TestRoundTrip(t *testing.T) {
	vars := map[string]string{"PLAIN": "abc-1.2", "SPACE": "a b", "QUOTE": "it's", "NL": "a\nb\"c\\", "REF": "${{db.URL}}", "EMPTY": ""}
	got, err := Parse(Format(vars))
	if err != nil {
		t.Fatal(err)
	}
	back := map[string]string{}
	for _, v := range got {
		back[v.Key] = v.Value
	}
	if !reflect.DeepEqual(back, vars) {
		t.Fatalf("round trip:\n got  %q\n want %q\n file %s", back, vars, Format(vars))
	}
}
