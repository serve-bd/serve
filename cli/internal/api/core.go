package api

import (
	"context"
	"encoding/json"
)

// ProjectDetails is GET /projects/{id}: the project with its environments and services.
type ProjectDetails struct {
	raw          json.RawMessage
	ID           string        `json:"id"`
	Name         string        `json:"name"`
	Description  *string       `json:"description"`
	CreatedAt    string        `json:"createdAt"`
	Environments []Environment `json:"environments"`
	Services     []Service     `json:"services"`
}

// Container is one row of GET /services/{id}/containers.
type Container struct {
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	Image          string  `json:"image"`
	State          string  `json:"state"`
	Status         string  `json:"status"`
	DeploymentID   *string `json:"deploymentId"`
	ComposeService *string `json:"composeService"`
	CreatedAt      string  `json:"createdAt"`
}

// TemplateVar is a value a template's compose file uses.
type TemplateVar struct {
	Key         string `json:"key"`
	Generate    string `json:"generate,omitempty"`
	Value       string `json:"value,omitempty"`
	PublicURL   bool   `json:"publicUrl,omitempty"`
	PublicHost  bool   `json:"publicHost,omitempty"`
	ServiceURL  string `json:"serviceUrl,omitempty"`
	ServiceHost string `json:"serviceHost,omitempty"`
	Label       string `json:"label,omitempty"`
}

// Automatic says whether Serve fills the value itself (generated, or a domain).
func (v TemplateVar) Automatic() bool {
	return v.Generate != "" || v.PublicURL || v.PublicHost || v.ServiceURL != "" || v.ServiceHost != ""
}

// Template is a one-click template. Compose, Note and HostAccess come only with GET /templates/{id}.
type Template struct {
	raw         json.RawMessage
	ID          string        `json:"id"`
	Name        string        `json:"name"`
	Description string        `json:"description"`
	Category    string        `json:"category"`
	Website     string        `json:"website"`
	Vars        []TemplateVar `json:"vars"`
	Compose     string        `json:"compose"`
	Note        string        `json:"note"`
	HostAccess  bool          `json:"hostAccess"`
}

// GitCredential is a Git connection (a token, an app or a deploy key). Secrets are never sent.
type GitCredential struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Provider string `json:"provider"`
}

func (c *Client) Project(ctx context.Context, id string) (*ProjectDetails, error) {
	var r struct{ Project ProjectDetails }
	return &r.Project, c.Get(ctx, "/projects/"+P(id), nil, &r)
}

func (c *Client) Containers(ctx context.Context, serviceID string) ([]Container, error) {
	var r struct{ Containers []Container }
	return r.Containers, c.Get(ctx, "/services/"+P(serviceID)+"/containers", nil, &r)
}

func (c *Client) Templates(ctx context.Context) ([]Template, error) {
	var r struct{ Templates []Template }
	return r.Templates, c.Get(ctx, "/templates", nil, &r)
}

func (c *Client) Template(ctx context.Context, id string) (*Template, error) {
	var r struct{ Template Template }
	return &r.Template, c.Get(ctx, "/templates/"+P(id), nil, &r)
}

func (c *Client) GitCredentials(ctx context.Context) ([]GitCredential, error) {
	var r struct{ Credentials []GitCredential }
	return r.Credentials, c.Get(ctx, "/git/credentials", nil, &r)
}

func (v *ProjectDetails) UnmarshalJSON(b []byte) error {
	type plain ProjectDetails
	if err := json.Unmarshal(b, (*plain)(v)); err != nil {
		return err
	}
	v.raw = append(json.RawMessage(nil), b...)
	return nil
}

func (v ProjectDetails) MarshalJSON() ([]byte, error) {
	if v.raw != nil {
		return v.raw, nil
	}
	type plain ProjectDetails
	return json.Marshal(plain(v))
}

func (v *Template) UnmarshalJSON(b []byte) error {
	type plain Template
	if err := json.Unmarshal(b, (*plain)(v)); err != nil {
		return err
	}
	v.raw = append(json.RawMessage(nil), b...)
	return nil
}

func (v Template) MarshalJSON() ([]byte, error) {
	if v.raw != nil {
		return v.raw, nil
	}
	type plain Template
	return json.Marshal(plain(v))
}
