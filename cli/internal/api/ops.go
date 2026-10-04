package api

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
)

// Types and calls for the day-to-day settings of a service: scheduled tasks, previews, tags,
// uptime checks and shared variables.

type Task struct {
	ID             string  `json:"id"`
	ServiceID      string  `json:"serviceId"`
	Name           string  `json:"name"`
	Schedule       string  `json:"schedule"`
	Command        string  `json:"command"`
	ComposeService *string `json:"composeService"`
	Enabled        bool    `json:"enabled"`
	TimeoutSeconds int     `json:"timeoutSeconds"`
	LastRunAt      *string `json:"lastRunAt"`
	LastStatus     *string `json:"lastStatus"`
}

type TaskRun struct {
	ID         string  `json:"id"`
	Trigger    string  `json:"trigger"`
	Status     string  `json:"status"`
	ExitCode   *int    `json:"exitCode"`
	Output     string  `json:"output"`
	StartedAt  *string `json:"startedAt"`
	FinishedAt *string `json:"finishedAt"`
}

type Tag struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Color      string   `json:"color"`
	ServiceIDs []string `json:"serviceIds"`
}

type PullRequest struct {
	Number    int     `json:"number"`
	Title     string  `json:"title"`
	Branch    string  `json:"branch"`
	Author    *string `json:"author"`
	Fork      bool    `json:"fork"`
	URL       string  `json:"url"`
	UpdatedAt *string `json:"updatedAt"`
	PreviewID *string `json:"previewId"`
}

// Preview is a pull request preview: a service whose parent is the app.
type Preview struct {
	ID              string  `json:"id"`
	Name            string  `json:"name"`
	Status          string  `json:"status"`
	ParentServiceID *string `json:"parentServiceId"`
	PreviewPr       *int    `json:"previewPr"`
}

type SharedVar struct {
	Key   string  `json:"key"`
	Value *string `json:"value,omitempty"`
}

// DNSCheck is where a domain's name points (POST /domains/{id}/check-dns).
type DNSCheck struct {
	Status  string   `json:"status"`
	Records []string `json:"records"`
	Origin  []string `json:"origin,omitempty"`
}

// CheckResult is one run of an uptime check.
type CheckResult struct {
	OK         bool    `json:"ok"`
	LatencyMs  *int    `json:"latencyMs"`
	StatusCode *int    `json:"statusCode"`
	Error      *string `json:"error"`
}

// PutJSON sends a PUT with a JSON body.
func (c *Client) PutJSON(ctx context.Context, path string, body any, out any) error {
	return c.Do(ctx, Request{Method: http.MethodPut, Path: path, JSON: body}, out)
}

func (c *Client) Tasks(ctx context.Context, serviceID string) ([]Task, error) {
	var r struct{ Tasks []Task }
	return r.Tasks, c.Get(ctx, "/services/"+P(serviceID)+"/tasks", nil, &r)
}

func (c *Client) TaskRuns(ctx context.Context, taskID string) ([]TaskRun, error) {
	var r struct{ Runs []TaskRun }
	return r.Runs, c.Get(ctx, "/tasks/"+P(taskID)+"/runs", nil, &r)
}

func (c *Client) Tags(ctx context.Context) ([]Tag, error) {
	var r struct{ Tags []Tag }
	return r.Tags, c.Get(ctx, "/tags", nil, &r)
}

func (c *Client) PullRequests(ctx context.Context, serviceID string) ([]PullRequest, error) {
	var r struct {
		PullRequests []PullRequest `json:"pullRequests"`
	}
	return r.PullRequests, c.Get(ctx, "/services/"+P(serviceID)+"/pull-requests", nil, &r)
}

// Previews lists the previews of an app (services of its environment whose parent it is).
func (c *Client) Previews(ctx context.Context, app *Service) ([]Preview, error) {
	var out []Preview
	for offset := 0; ; offset += 200 {
		q := url.Values{"limit": {"200"}, "offset": {strconv.Itoa(offset)}, "projectId": {app.ProjectID}, "environmentId": {app.EnvironmentID}}
		var r struct{ Services []Preview }
		if err := c.Get(ctx, "/services", q, &r); err != nil {
			return nil, err
		}
		for _, s := range r.Services {
			if s.ParentServiceID != nil && *s.ParentServiceID == app.ID {
				out = append(out, s)
			}
		}
		if len(r.Services) < 200 {
			return out, nil
		}
	}
}

// SharedVars reads the shared variables at a path: /variables, /projects/{id}/variables or
// /environments/{id}/variables. Values are missing without variables.view-secrets.
func (c *Client) SharedVars(ctx context.Context, path string) ([]SharedVar, error) {
	var r struct{ Variables []SharedVar }
	return r.Variables, c.Get(ctx, path, nil, &r)
}
