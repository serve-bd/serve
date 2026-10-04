package cmd

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// builders are the ways Serve turns a folder into an image, in the order they are offered.
var builders = []struct{ id, label string }{
	{"auto", "Auto: Serve picks (a Dockerfile if there is one, else it detects the language)"},
	{"dockerfile", "Dockerfile"},
	{"nixpacks", "Nixpacks"},
	{"railpack", "Railpack"},
	{"buildpacks", "Cloud Native Buildpacks"},
	{"static", "Static site (served by nginx)"},
}

func validBuilder(b string) bool {
	for _, x := range builders {
		if x.id == b {
			return true
		}
	}
	return false
}

func builderNames() string {
	names := make([]string, len(builders))
	for i, b := range builders {
		names[i] = b.id
	}
	return strings.Join(names, ", ")
}

// buildChoice is a builder and the settings it needs.
type buildChoice struct {
	builder, publishDir, buildCommand, startCommand string
}

// body is the partial build setting the API takes; empty fields stay as they are.
func (b buildChoice) body() map[string]any {
	m := map[string]any{}
	if b.builder != "" {
		m["builder"] = b.builder
	}
	if b.publishDir != "" {
		m["publishDir"] = b.publishDir
	}
	if b.buildCommand != "" {
		m["buildCommand"] = b.buildCommand
	}
	if b.startCommand != "" {
		m["startCommand"] = b.startCommand
	}
	return m
}

func exists(dir, name string) bool {
	_, err := os.Stat(filepath.Join(dir, name))
	return err == nil
}

// suggestBuilder guesses from the folder: a Dockerfile, a plain static site, or auto.
func suggestBuilder(dir string) (string, string) {
	if exists(dir, "Dockerfile") {
		return "dockerfile", "found a Dockerfile"
	}
	markers := []string{"package.json", "go.mod", "requirements.txt", "pyproject.toml", "Gemfile", "composer.json", "Cargo.toml", "pom.xml", "build.gradle", "mix.exs", "deno.json"}
	for _, m := range markers {
		if exists(dir, m) {
			return "auto", "found " + m
		}
	}
	if exists(dir, "index.html") {
		return "static", "found index.html and no app files"
	}
	return "auto", ""
}

// pickBuild settles the builder for a new or changed app: the flag, or a pick that starts at the guess.
func pickBuild(dir string, given buildChoice) (buildChoice, error) {
	c := given
	if c.builder != "" && !validBuilder(c.builder) {
		return c, usagef("--builder must be one of: %s", builderNames())
	}
	if c.builder == "" {
		guess, why := suggestBuilder(dir)
		if !ui.Interactive {
			c.builder = guess
		} else {
			opts := make([]ui.Option, 0, len(builders))
			for _, b := range builders {
				if b.id == guess {
					label := b.label
					if why != "" {
						label += "  (" + why + ")"
					}
					opts = append([]ui.Option{{Label: label, Value: b.id}}, opts...)
				} else {
					opts = append(opts, ui.Option{Label: b.label, Value: b.id})
				}
			}
			v, err := ui.Select("Builder", opts)
			if err != nil {
				return c, needChoice(err, "pass --builder")
			}
			c.builder = v
		}
	}
	if c.builder == "dockerfile" && !exists(dir, "Dockerfile") {
		ui.Warn("There is no Dockerfile in %s. Add one before you deploy, or pick another builder.", dir)
	}
	if c.builder == "static" && c.publishDir == "" {
		def := "."
		for _, d := range []string{"dist", "build", "public", "out"} {
			if exists(dir, filepath.Join(d, "index.html")) {
				def = d
				break
			}
		}
		c.publishDir = def
		if ui.Interactive {
			v, err := ui.Input("Folder with the site's files", def, def)
			if err != nil {
				return c, err
			}
			if v != "" {
				c.publishDir = v
			}
		}
	}
	return c, nil
}

// setBuild changes the builder settings of an app.
func (a *App) setBuild(ctx context.Context, s *api.Service, c buildChoice) error {
	return a.client.Patch(ctx, "/services/"+api.P(s.ID), map[string]any{"build": c.body()}, nil)
}

func (a *App) builderCmd() *cobra.Command {
	var c buildChoice
	cmd := &cobra.Command{
		Use:   "builder [name]",
		Short: "Show or change how the app is built",
		Long: `Show how the linked app is built, or change it. Builders: ` + builderNames() + `.
With no name on a terminal, pick one from a list. The change applies from the next deploy.`,
		Args: maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.target(ctx, ".", appService)
			if err != nil {
				return err
			}
			if len(args) > 0 {
				c.builder = args[0]
			}
			changing := c.builder != "" || c.publishDir != "" || c.buildCommand != "" || c.startCommand != ""
			if !changing && !ui.Interactive {
				printBuild(s)
				return nil
			}
			if !changing {
				printBuild(s)
				ui.Info("")
			}
			// Only other settings given (--start-command and such): the builder stays.
			if c.builder != "" || !changing {
				if c, err = pickBuild(".", c); err != nil {
					return err
				}
			}
			if err := a.setBuild(ctx, s, c); err != nil {
				return err
			}
			ui.Success("%s now builds with %s. It applies from the next deploy.", ui.Bold(s.Name), ui.Bold(firstNonEmpty(c.builder, currentBuilder(s))))
			return nil
		},
	}
	cmd.Flags().StringVar(&c.publishDir, "publish-dir", "", "folder with the site's files (static builder)")
	cmd.Flags().StringVar(&c.buildCommand, "build-command", "", "command that builds the app")
	cmd.Flags().StringVar(&c.startCommand, "start-command", "", "command that starts the app")
	return cmd
}

func currentBuilder(s *api.Service) string {
	if s.Build == nil || s.Build.Builder == "" {
		return "auto"
	}
	return s.Build.Builder
}

func printBuild(s *api.Service) {
	rows := [][2]string{{"Builder", currentBuilder(s)}}
	if b := s.Build; b != nil {
		if b.Builder == "dockerfile" && b.Dockerfile != "" {
			rows = append(rows, [2]string{"Dockerfile", b.Dockerfile})
		}
		if b.BuildCommand != nil && *b.BuildCommand != "" {
			rows = append(rows, [2]string{"Build command", *b.BuildCommand})
		}
		if b.StartCommand != nil && *b.StartCommand != "" {
			rows = append(rows, [2]string{"Start command", *b.StartCommand})
		}
		if b.PublishDir != nil && *b.PublishDir != "" {
			rows = append(rows, [2]string{"Publish folder", *b.PublishDir})
		}
	}
	for _, r := range rows {
		fmt.Printf("%-15s %s\n", r[0], r[1])
	}
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}
