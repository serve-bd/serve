package cmd

import (
	"errors"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

func guardTree(run func(*cobra.Command, []string) error) *cobra.Command {
	root := &cobra.Command{Use: "serve", SilenceErrors: true, SilenceUsage: true}
	db := &cobra.Command{Use: "db"}
	db.AddCommand(&cobra.Command{Use: "url", RunE: func(*cobra.Command, []string) error { return nil }})
	backups := &cobra.Command{Use: "backups [service]", RunE: run}
	backups.AddCommand(&cobra.Command{Use: "create", RunE: func(*cobra.Command, []string) error { return nil }})
	db.AddCommand(backups)
	root.AddCommand(db)
	guardGroups(root)
	return root
}

func TestGuardGroupsSuggestsSubcommands(t *testing.T) {
	notFound := func(_ *cobra.Command, args []string) error {
		return errors.New("there is no service named " + args[0])
	}
	root := guardTree(notFound)

	root.SetArgs([]string{"db", "ulr"})
	if err := root.Execute(); err == nil || !strings.Contains(err.Error(), "Did you mean serve db url?") {
		t.Fatalf("pure group: %v", err)
	}

	root.SetArgs([]string{"db", "backups", "craete"})
	if err := root.Execute(); err == nil || !strings.Contains(err.Error(), "Did you mean `serve db backups create`?") {
		t.Fatalf("group with a name: %v", err)
	}

	root.SetArgs([]string{"db", "backups", "zzzzzz"})
	if err := root.Execute(); err == nil || strings.Contains(err.Error(), "Did you mean") {
		t.Fatalf("a name far from every subcommand gets no hint: %v", err)
	}

	ok := guardTree(func(*cobra.Command, []string) error { return nil })
	ok.SetArgs([]string{"db", "backups", "craete"})
	if err := ok.Execute(); err != nil {
		t.Fatalf("a name that is found runs as before: %v", err)
	}
}
