package api

import (
	"context"
	"encoding/json"
	"net/url"
)

// DatabaseInfo is the database part of a service: its engine, version and main login.
type DatabaseInfo struct {
	Engine   string `json:"engine"`
	Version  string `json:"version"`
	Username string `json:"username"`
	Database string `json:"database"`
}

// DatabaseInfo reads the database settings of a service from the answer it was read from.
func (s *Service) DatabaseInfo() DatabaseInfo {
	var v struct {
		Database *DatabaseInfo `json:"database"`
	}
	if s.raw != nil {
		_ = json.Unmarshal(s.raw, &v)
	}
	if v.Database == nil {
		if s.Database != nil {
			return DatabaseInfo{Engine: s.Database.Engine}
		}
		return DatabaseInfo{}
	}
	return *v.Database
}

type Backup struct {
	ID            string   `json:"id"`
	Status        string   `json:"status"` // running, success, failed
	Trigger       string   `json:"trigger"`
	Target        *string  `json:"target"`
	Databases     []string `json:"databases"`
	Filename      *string  `json:"filename"`
	Size          *int64   `json:"size"`
	Destination   *string  `json:"destination"`
	Error         *string  `json:"error"`
	RestoreStatus *string  `json:"restoreStatus"` // running, success, failed
	RestoredAt    *string  `json:"restoredAt"`
	CreatedAt     string   `json:"createdAt"`
	FinishedAt    *string  `json:"finishedAt"`
}

func (c *Client) Backups(ctx context.Context, serviceID string) ([]Backup, error) {
	var r struct{ Backups []Backup }
	return r.Backups, c.Get(ctx, "/services/"+P(serviceID)+"/backups", nil, &r)
}

type Branch struct {
	ID                 string   `json:"id"`
	Name               string   `json:"name"`
	Database           string   `json:"database"`
	Username           string   `json:"username"`
	Status             string   `json:"status"` // creating, ready, resetting, failed, deleting
	Error              *string  `json:"error"`
	SizeBytes          *int64   `json:"sizeBytes"`
	PersonalDataHidden bool     `json:"personalDataHidden"`
	SourceBranchID     *string  `json:"sourceBranchId"`
	AllDatabases       bool     `json:"allDatabases"`
	ExtraDatabases     []string `json:"extraDatabases"`
	CopiedAt           *string  `json:"copiedAt"`
	PreviewServiceID   *string  `json:"previewServiceId"`
	CreatedAt          string   `json:"createdAt"`
}

func (c *Client) Branches(ctx context.Context, serviceID string) ([]Branch, error) {
	var r struct{ Branches []Branch }
	return r.Branches, c.Get(ctx, "/services/"+P(serviceID)+"/branches", nil, &r)
}

type DatabaseUser struct {
	Username        string   `json:"username"`
	Managed         bool     `json:"managed"`
	KnowsPassword   bool     `json:"knowsPassword"`
	ProtectedReason *string  `json:"protectedReason"`
	Access          *string  `json:"access"`
	Databases       []string `json:"databases"`
	CreatedAt       *string  `json:"createdAt"`
}

type DatabaseUsers struct {
	Users        []DatabaseUser `json:"users"`
	Databases    []string       `json:"databases"`
	MainDatabase string         `json:"mainDatabase"`
}

func (c *Client) DatabaseUsers(ctx context.Context, serviceID string) (*DatabaseUsers, error) {
	var r DatabaseUsers
	return &r, c.Get(ctx, "/services/"+P(serviceID)+"/users", nil, &r)
}

// DatabaseUserLogin is a user's password and connection URLs.
type DatabaseUserLogin struct {
	Username   string  `json:"username"`
	Password   string  `json:"password"`
	PrivateURL string  `json:"privateUrl"`
	PublicURL  *string `json:"publicUrl"`
}

type TableInfo struct {
	Schema *string `json:"schema"`
	Name   string  `json:"name"`
	Kind   string  `json:"kind"`
	Rows   *int64  `json:"rows"`
	Bytes  *int64  `json:"bytes"`
}

// DataOverview is the databases of a database service and the tables of one of them.
type DataOverview struct {
	Engine    string `json:"engine"`
	Family    string `json:"family"` // sql, mongo, kv
	Databases []struct {
		Name string `json:"name"`
		Size *int64 `json:"size"`
	} `json:"databases"`
	Database string      `json:"database"`
	Schemas  []string    `json:"schemas"`
	Tables   []TableInfo `json:"tables"`
}

func (c *Client) DataOverview(ctx context.Context, serviceID, database string) (*DataOverview, error) {
	q := url.Values{}
	if database != "" {
		q.Set("database", database)
	}
	var r DataOverview
	return &r, c.Get(ctx, "/services/"+P(serviceID)+"/data", q, &r)
}

// QueryResult is the answer of POST /services/{id}/data/query. Error is the database's own
// error (the request itself succeeded).
type QueryResult struct {
	Result *struct {
		Kind      string      `json:"kind"` // rows, documents, done, value, text
		Columns   []string    `json:"columns,omitempty"`
		Rows      [][]*string `json:"rows,omitempty"`
		Truncated bool        `json:"truncated,omitempty"`
		RowCount  *int64      `json:"rowCount,omitempty"`
		Documents []string    `json:"documents,omitempty"`
		Affected  *int64      `json:"affected,omitempty"`
		Message   *string     `json:"message,omitempty"`
		Value     *string     `json:"value,omitempty"`
		Text      *string     `json:"text,omitempty"`
	} `json:"result"`
	Error *string `json:"error"`
	Ms    int64   `json:"ms"`
}

type Replica struct {
	ID         string   `json:"id"`
	ServerID   string   `json:"serverId"`
	State      string   `json:"state"` // copying, following, stopped, failed
	LagSeconds *float64 `json:"lagSeconds"`
	Error      *string  `json:"error"`
}

func (c *Client) Replicas(ctx context.Context, serviceID string) ([]Replica, error) {
	var r struct{ Replicas []Replica }
	return r.Replicas, c.Get(ctx, "/services/"+P(serviceID)+"/database/replicas", nil, &r)
}

// Dependent is a service whose variables use a database.
type Dependent struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

func (c *Client) Dependents(ctx context.Context, serviceID string) ([]Dependent, error) {
	var r struct{ Dependents []Dependent }
	return r.Dependents, c.Get(ctx, "/services/"+P(serviceID)+"/database/dependents", nil, &r)
}
