package cmd

import (
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/serve-bd/serve/cli/internal/api"
	"github.com/serve-bd/serve/cli/internal/ui"
	"github.com/spf13/cobra"
)

// maxCell is how much of one value a table shows; --json gives all of it.
const maxCell = 200

// cell makes a value fit on one table line.
func cell(v *string) string {
	if v == nil {
		return ui.OutDim("NULL")
	}
	s := strings.NewReplacer("\r\n", `\n`, "\n", `\n`, "\r", `\r`, "\t", " ").Replace(*v)
	s = ui.SanitizeLine(s, false)
	if utf8.RuneCountInString(s) > maxCell {
		s = string([]rune(s)[:maxCell]) + "…"
	}
	return s
}

func (a *App) dbQueryCmd() *cobra.Command {
	var database, collection, op, field string
	var write, asJSON bool
	cmd := &cobra.Command{
		Use:   "query [database] <query | ->",
		Short: "Run a query and print the result",
		Long: `Run a query in the database and print the result as a table. The query is SQL for
PostgreSQL, MySQL, MariaDB and ClickHouse, and a command for Redis and Valkey (like GET "my key").
For MongoDB it is the Extended JSON of an operation on --collection: a filter for find, count
and distinct (with --field), a pipeline for aggregate. - reads the query from standard input.

Queries run read only unless --write (which needs the right to manage services, and is written
to the activity log). They stop after 30 seconds, and at most 1000 rows come back. --database
picks the database inside the server (the main one by default; for Redis and Valkey a number).
The database service is the one named first, --service, or the linked one.`,
		Example: `  serve db query "select id, email from users limit 5"
  serve db query postgres "select count(*) from orders"
  cat report.sql | serve db query -
  serve db query --write "update users set plan = 'pro' where id = 7"
  serve db query cache 'GET "session:42"'
  serve db query mongo --collection users '{"plan": "pro"}'`,
		Args: func(cmd *cobra.Command, args []string) error {
			if len(args) < 1 || len(args) > 2 {
				return usagef("give the query, and before it the database's name if you like")
			}
			return nil
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			query, err := readArg(args[len(args)-1], "query")
			if err != nil {
				return err
			}
			s, err := a.database(ctx, args[:len(args)-1])
			if err != nil {
				return err
			}
			info := s.DatabaseInfo()
			db := database
			if db == "" {
				switch info.Engine {
				case "redis", "valkey":
					db = "0"
				default:
					db = info.Database
				}
			}
			if db == "" {
				return usagef("name the database inside %s with --database", s.Name)
			}
			body := map[string]any{"database": db, "query": query, "readOnly": !write}
			if info.Engine == "mongodb" {
				if collection == "" {
					return usagef("a MongoDB query needs --collection")
				}
				body["collection"] = collection
				if op != "" {
					body["operation"] = op
				}
				if field != "" {
					body["field"] = field
				}
			} else if collection != "" || op != "" || field != "" {
				return usagef("--collection, --op and --field are for MongoDB")
			}
			var r api.QueryResult
			if err := a.client.Post(ctx, "/services/"+api.P(s.ID)+"/data/query", body, &r); err != nil {
				return err
			}
			if asJSON {
				if err := printJSON(r); err != nil {
					return err
				}
				if r.Error != nil {
					return silentExit(ExitError)
				}
				return nil
			}
			if r.Error != nil {
				return errors.New(*r.Error)
			}
			if r.Result == nil {
				return errors.New("the server sent no result")
			}
			res := r.Result
			took := fmt.Sprintf("%d ms", r.Ms)
			switch res.Kind {
			case "rows":
				rows := make([][]string, len(res.Rows))
				for i, row := range res.Rows {
					rows[i] = make([]string, len(row))
					for j, v := range row {
						rows[i][j] = cell(v)
					}
				}
				if len(res.Columns) > 0 {
					ui.Table(res.Columns, rows)
				}
				n := fmt.Sprintf("%d rows", len(res.Rows))
				if len(res.Rows) == 1 {
					n = "1 row"
				}
				if len(res.Columns) == 0 && res.RowCount != nil {
					n = fmt.Sprintf("%d rows changed", *res.RowCount)
				}
				ui.Line(ui.Dim(fmt.Sprintf("%s (%s)", n, took)))
				if res.Truncated {
					ui.Warn("Only the first rows came back. Narrow the query, or add a limit.")
				}
			case "documents":
				for _, d := range res.Documents {
					fmt.Fprintln(ui.Out, d)
				}
				ui.Line(ui.Dim(fmt.Sprintf("%d documents (%s)", len(res.Documents), took)))
				if res.Truncated {
					ui.Warn("Only the first documents came back. Narrow the filter.")
				}
			case "done":
				msg := "Done"
				if res.Affected != nil {
					msg = fmt.Sprintf("%d changed", *res.Affected)
				}
				if m := deref(res.Message); m != "" {
					msg = m
				}
				ui.Line(ui.Dim(fmt.Sprintf("%s (%s)", msg, took)))
			case "value":
				fmt.Fprintln(ui.Out, deref(res.Value))
			case "text":
				fmt.Fprintln(ui.Out, deref(res.Text))
			default:
				return printJSON(res)
			}
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVarP(&database, "database", "d", "", "the database inside the server (default: the main one)")
	f.BoolVar(&write, "write", false, "allow the query to change data")
	f.StringVarP(&collection, "collection", "c", "", "MongoDB: the collection")
	f.StringVar(&op, "op", "", "MongoDB: find (default), count, distinct, aggregate, insert, update or delete")
	f.StringVar(&field, "field", "", "MongoDB distinct: the field to list the values of")
	f.BoolVar(&asJSON, "json", false, "print JSON")
	return cmd
}

func (a *App) dbTablesCmd() *cobra.Command {
	var database string
	var asJSON bool
	cmd := &cobra.Command{
		Use:     "tables [database]",
		Aliases: []string{"ls-tables"},
		Short:   "List the databases and tables of a database",
		Long: `List the databases on the server, then the tables (or collections) of the main one, or of
--database, with estimated row counts and sizes. For Redis and Valkey: the database numbers that
hold keys.`,
		Example: "  serve db tables\n  serve db tables postgres --database analytics\n  serve db tables --json",
		Args:    maxArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			s, err := a.database(ctx, args)
			if err != nil {
				return err
			}
			o, err := a.client.DataOverview(ctx, s.ID, database)
			if err != nil {
				return err
			}
			if asJSON {
				return printJSON(o)
			}
			var rows [][]string
			for _, d := range o.Databases {
				size := ""
				if d.Size != nil {
					if o.Family == "kv" {
						size = fmt.Sprintf("%d keys", *d.Size)
					} else {
						size = ui.Bytes(*d.Size)
					}
				}
				mark := ""
				if d.Name == o.Database {
					mark = ui.OutDim("listed below")
					if o.Family == "kv" {
						mark = ""
					}
				}
				rows = append(rows, []string{d.Name, size, mark})
			}
			ui.Table([]string{"DATABASE", "SIZE", ""}, rows)
			if o.Family == "kv" {
				return nil
			}
			fmt.Fprintln(ui.Out)
			if len(o.Tables) == 0 {
				ui.Info("%s has no tables.", o.Database)
				return nil
			}
			rows = nil
			for _, t := range o.Tables {
				name := t.Name
				if sc := deref(t.Schema); sc != "" && sc != "public" {
					name = sc + "." + name
				}
				count, size := "", ""
				if t.Rows != nil {
					count = fmt.Sprint(*t.Rows)
				}
				if t.Bytes != nil {
					size = ui.Bytes(*t.Bytes)
				}
				rows = append(rows, []string{name, t.Kind, count, size})
			}
			what := "TABLE"
			if o.Family == "mongo" {
				what = "COLLECTION"
			}
			ui.Table([]string{what + " (" + o.Database + ")", "KIND", "ROWS", "SIZE"}, rows)
			return nil
		},
	}
	cmd.Flags().StringVarP(&database, "database", "d", "", "list the tables of this database (default: the main one)")
	cmd.Flags().BoolVar(&asJSON, "json", false, "print JSON")
	return cmd
}
