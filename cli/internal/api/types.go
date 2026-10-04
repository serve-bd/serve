package api

import (
	"context"
	"encoding/json"
	"net/url"
	"strconv"
)

type Me struct {
	raw   json.RawMessage
	Token struct {
		ID        string `json:"id"`
		Name      string `json:"name"`
		ExpiresAt string `json:"expiresAt"`
	} `json:"token"`
	User struct {
		ID    string `json:"id"`
		Name  string `json:"name"`
		Email string `json:"email"`
	} `json:"user"`
	Organization struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		Slug string `json:"slug"`
	} `json:"organization"`
	Permissions []string `json:"permissions"`
	Admin       bool     `json:"admin"`
}

type Project struct {
	raw         json.RawMessage
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description *string `json:"description"`
	CreatedAt   string  `json:"createdAt"`
}

type Environment struct {
	raw       json.RawMessage
	ID        string `json:"id"`
	ProjectID string `json:"projectId"`
	Name      string `json:"name"`
}

type Service struct {
	raw           json.RawMessage
	ID            string          `json:"id"`
	Name          string          `json:"name"`
	Slug          string          `json:"slug"`
	Type          string          `json:"type"`
	Status        string          `json:"status"`
	ProjectID     string          `json:"projectId"`
	Project       string          `json:"project"`
	EnvironmentID string          `json:"environmentId"`
	ServerID      string          `json:"serverId"`
	Source        json.RawMessage `json:"source"`
	Runtime       struct {
		Replicas int  `json:"replicas"`
		Port     *int `json:"port"`
	} `json:"runtime"`
	Build *struct {
		RootDir string `json:"rootDir"`
	} `json:"build"`
	Database *struct {
		Engine string `json:"engine"`
	} `json:"database"`
	CurrentDeploymentID *string  `json:"currentDeploymentId"`
	Domains             []string `json:"domains"`
	Variables           []string `json:"variables"`
	ParentServiceID     *string  `json:"parentServiceId"`
}

// SourceType is git, image, dockerfile or upload for an app; empty otherwise.
func (s *Service) SourceType() string {
	var src struct {
		Type       string `json:"type"`
		Repository string `json:"repository"`
	}
	_ = json.Unmarshal(s.Source, &src)
	return src.Type
}

// Kind is the type for messages: "postgres database", "upload app", "compose".
func (s *Service) Kind() string {
	switch s.Type {
	case "database":
		if s.Database != nil {
			return s.Database.Engine
		}
	case "app":
		if t := s.SourceType(); t != "" {
			return t + " app"
		}
	}
	return s.Type
}

type Deployment struct {
	raw           json.RawMessage
	ID            string  `json:"id"`
	ServiceID     string  `json:"serviceId"`
	Status        string  `json:"status"`
	Trigger       string  `json:"trigger"`
	Image         *string `json:"image"`
	CommitSha     *string `json:"commitSha"`
	CommitMessage *string `json:"commitMessage"`
	Branch        *string `json:"branch"`
	RollbackOf    *string `json:"rollbackOf"`
	Error         *string `json:"error"`
	CreatedAt     string  `json:"createdAt"`
	StartedAt     *string `json:"startedAt"`
	FinishedAt    *string `json:"finishedAt"`
	LogTail       string  `json:"logTail,omitempty"`
	// Upload describes the folder of a CLI deploy.
	Upload *struct {
		Size  int64 `json:"size"`
		Files int   `json:"files"`
		Dirty bool  `json:"dirty"`
	} `json:"upload"`
}

// Terminal says whether a deployment status is final.
func Terminal(status string) bool {
	switch status {
	case "success", "failed", "cancelled", "superseded":
		return true
	}
	return false
}

// Active says whether a deployment may still be cancelled.
func Active(status string) bool {
	switch status {
	case "waiting", "queued", "building", "deploying":
		return true
	}
	return false
}

type Domain struct {
	raw       json.RawMessage
	ID        string `json:"id"`
	Hostname  string `json:"hostname"`
	URL       string `json:"url"`
	HTTPS     bool   `json:"https"`
	Generated bool   `json:"generated"`
	Primary   bool   `json:"primary"`
}

type Server struct {
	raw      json.RawMessage
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	IsLocal  bool    `json:"isLocal"`
	Host     *string `json:"host"`
	Status   string  `json:"status"`
	PublicIP *string `json:"publicIp"`
}

type Variable struct {
	Key       string  `json:"key"`
	Value     *string `json:"value,omitempty"`
	BuildTime bool    `json:"buildTime"`
	Runtime   bool    `json:"runtime"`
	Literal   bool    `json:"literal"`
	Multiline bool    `json:"multiline"`
}

type Connection struct {
	Engine     string            `json:"engine"`
	Variables  map[string]string `json:"variables"`
	PublicPort *int              `json:"publicPort"`
	Domain     *string           `json:"domain"`
	PublicURL  *string           `json:"publicUrl"`
}

type ContainerLogs struct {
	ID    string   `json:"id"`
	Name  string   `json:"name"`
	State string   `json:"state"`
	Lines []string `json:"lines"`
}

// Typed calls.

func (c *Client) Me(ctx context.Context) (*Me, error) {
	var me Me
	return &me, c.Get(ctx, "/me", nil, &me)
}

func (c *Client) Projects(ctx context.Context) ([]Project, error) {
	var r struct{ Projects []Project }
	return r.Projects, c.Get(ctx, "/projects", nil, &r)
}

func (c *Client) Environments(ctx context.Context, projectID string) ([]Environment, error) {
	var r struct{ Environments []Environment }
	return r.Environments, c.Get(ctx, "/projects/"+P(projectID)+"/environments", nil, &r)
}

// Services lists services, all pages, filtered by project and environment when given.
func (c *Client) Services(ctx context.Context, projectID, environmentID string) ([]Service, error) {
	var all []Service
	for offset := 0; ; offset += 200 {
		q := url.Values{"limit": {"200"}, "offset": {strconv.Itoa(offset)}}
		if projectID != "" {
			q.Set("projectId", projectID)
		}
		if environmentID != "" {
			q.Set("environmentId", environmentID)
		}
		var r struct{ Services []Service }
		if err := c.Get(ctx, "/services", q, &r); err != nil {
			return nil, err
		}
		all = append(all, r.Services...)
		if len(r.Services) < 200 {
			return all, nil
		}
	}
}

func (c *Client) Service(ctx context.Context, id string) (*Service, error) {
	var r struct{ Service Service }
	return &r.Service, c.Get(ctx, "/services/"+P(id), nil, &r)
}

func (c *Client) Deployments(ctx context.Context, serviceID string, limit int) ([]Deployment, error) {
	var r struct{ Deployments []Deployment }
	return r.Deployments, c.Get(ctx, "/services/"+P(serviceID)+"/deployments", url.Values{"limit": {strconv.Itoa(limit)}}, &r)
}

func (c *Client) Deployment(ctx context.Context, id string) (*Deployment, error) {
	var r struct{ Deployment Deployment }
	return &r.Deployment, c.Get(ctx, "/deployments/"+P(id), nil, &r)
}

func (c *Client) Domains(ctx context.Context, serviceID string) ([]Domain, error) {
	var r struct{ Domains []Domain }
	return r.Domains, c.Get(ctx, "/services/"+P(serviceID)+"/domains", nil, &r)
}

func (c *Client) Servers(ctx context.Context) ([]Server, error) {
	var r struct{ Servers []Server }
	return r.Servers, c.Get(ctx, "/servers", nil, &r)
}

func (c *Client) Variables(ctx context.Context, serviceID string) ([]Variable, error) {
	var r struct{ Variables []Variable }
	return r.Variables, c.Get(ctx, "/services/"+P(serviceID)+"/variables", nil, &r)
}

// DeploymentIDOf finds the deployment id in an answer that may name it id or deploymentId.
func DeploymentIDOf(m map[string]any) string {
	for _, k := range []string{"deploymentId", "id"} {
		if s, ok := m[k].(string); ok && s != "" {
			return s
		}
	}
	if d, ok := m["deployment"].(map[string]any); ok {
		if s, ok := d["id"].(string); ok {
			return s
		}
	}
	return ""
}

// Each type keeps the JSON it was read from, so --json prints every field the server sent,
// not only the ones the CLI uses.

func (v *Project) UnmarshalJSON(b []byte) error {
	type plain Project
	if err := json.Unmarshal(b, (*plain)(v)); err != nil {
		return err
	}
	v.raw = append(json.RawMessage(nil), b...)
	return nil
}

func (v Project) MarshalJSON() ([]byte, error) {
	if v.raw != nil {
		return v.raw, nil
	}
	type plain Project
	return json.Marshal(plain(v))
}

func (v *Environment) UnmarshalJSON(b []byte) error {
	type plain Environment
	if err := json.Unmarshal(b, (*plain)(v)); err != nil {
		return err
	}
	v.raw = append(json.RawMessage(nil), b...)
	return nil
}

func (v Environment) MarshalJSON() ([]byte, error) {
	if v.raw != nil {
		return v.raw, nil
	}
	type plain Environment
	return json.Marshal(plain(v))
}

func (v *Service) UnmarshalJSON(b []byte) error {
	type plain Service
	if err := json.Unmarshal(b, (*plain)(v)); err != nil {
		return err
	}
	v.raw = append(json.RawMessage(nil), b...)
	return nil
}

func (v Service) MarshalJSON() ([]byte, error) {
	if v.raw != nil {
		return v.raw, nil
	}
	type plain Service
	return json.Marshal(plain(v))
}

func (v *Deployment) UnmarshalJSON(b []byte) error {
	type plain Deployment
	if err := json.Unmarshal(b, (*plain)(v)); err != nil {
		return err
	}
	v.raw = append(json.RawMessage(nil), b...)
	return nil
}

func (v Deployment) MarshalJSON() ([]byte, error) {
	if v.raw != nil {
		return v.raw, nil
	}
	type plain Deployment
	return json.Marshal(plain(v))
}

func (v *Domain) UnmarshalJSON(b []byte) error {
	type plain Domain
	if err := json.Unmarshal(b, (*plain)(v)); err != nil {
		return err
	}
	v.raw = append(json.RawMessage(nil), b...)
	return nil
}

func (v Domain) MarshalJSON() ([]byte, error) {
	if v.raw != nil {
		return v.raw, nil
	}
	type plain Domain
	return json.Marshal(plain(v))
}

func (v *Server) UnmarshalJSON(b []byte) error {
	type plain Server
	if err := json.Unmarshal(b, (*plain)(v)); err != nil {
		return err
	}
	v.raw = append(json.RawMessage(nil), b...)
	return nil
}

func (v Server) MarshalJSON() ([]byte, error) {
	if v.raw != nil {
		return v.raw, nil
	}
	type plain Server
	return json.Marshal(plain(v))
}

func (v *Me) UnmarshalJSON(b []byte) error {
	type plain Me
	if err := json.Unmarshal(b, (*plain)(v)); err != nil {
		return err
	}
	v.raw = append(json.RawMessage(nil), b...)
	return nil
}

func (v Me) MarshalJSON() ([]byte, error) {
	if v.raw != nil {
		return v.raw, nil
	}
	type plain Me
	return json.Marshal(plain(v))
}
