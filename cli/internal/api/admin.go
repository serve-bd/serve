package api

import (
	"context"
	"encoding/json"
)

// ServerDetails is GET /servers/{id}: the server with the services on it. Alerts, ProxySwitch and
// SetupLog come from newer dashboards only.
type ServerDetails struct {
	ID                    string          `json:"id"`
	Name                  string          `json:"name"`
	Description           *string         `json:"description"`
	IsLocal               bool            `json:"isLocal"`
	Host                  *string         `json:"host"`
	Port                  *int            `json:"port"`
	Username              *string         `json:"username"`
	Status                string          `json:"status"`
	StatusMessage         *string         `json:"statusMessage"`
	PublicIP              *string         `json:"publicIp"`
	WildcardDomain        *string         `json:"wildcardDomain"`
	ProxyKind             *string         `json:"proxyKind"`
	ProxyHTTPPort         *int            `json:"proxyHttpPort"`
	ProxyHTTPSPort        *int            `json:"proxyHttpsPort"`
	ProxyStopped          bool            `json:"proxyStopped"`
	BuildConcurrency      *int            `json:"buildConcurrency"`
	MetricsEnabled        bool            `json:"metricsEnabled"`
	MetricsRetentionHours *int            `json:"metricsRetentionHours"`
	LastSeenAt            *string         `json:"lastSeenAt"`
	CreatedAt             string          `json:"createdAt"`
	Services              []ServerService `json:"services"`
	Alerts                *ServerAlerts   `json:"alerts"`
	ProxySwitch           *ProxySwitch    `json:"proxySwitch"`
	SetupLog              *string         `json:"setupLog"`
}

type ServerService struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Type   string `json:"type"`
	Status string `json:"status"`
}

// ServerAlerts is the body of PUT /servers/{id}/alerts (percentages, and minutes for the CPU).
type ServerAlerts struct {
	Enabled      bool `json:"enabled"`
	DiskWarn     int  `json:"diskWarn"`
	DiskCritical int  `json:"diskCritical"`
	Memory       int  `json:"memory"`
	CPU          int  `json:"cpu"`
	CPUMinutes   int  `json:"cpuMinutes"`
}

type ProxySwitch struct {
	State string `json:"state"`
	From  string `json:"from"`
	To    string `json:"to"`
	Log   string `json:"log"`
}

type SSHKey struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description *string `json:"description"`
	PublicKey   string  `json:"publicKey"`
	Fingerprint string  `json:"fingerprint"`
	CreatedAt   string  `json:"createdAt"`
}

type Certificate struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Domains   []string `json:"domains"`
	ServerID  *string  `json:"serverId"`
	Provider  string   `json:"provider"`
	Status    string   `json:"status"`
	Issuer    *string  `json:"issuer"`
	ExpiresAt *string  `json:"expiresAt"`
	AutoRenew bool     `json:"autoRenew"`
	LastError *string  `json:"lastError"`
	CreatedAt string   `json:"createdAt"`
}

type CloudflareAccount struct {
	ID    string  `json:"id"`
	Name  string  `json:"name"`
	Email *string `json:"email"`
}

// UpdateCheck is the last look for a new Serve release.
type UpdateCheck struct {
	CheckedAt   string  `json:"checkedAt"`
	Latest      *string `json:"latest"`
	URL         *string `json:"url"`
	Notes       *string `json:"notes"`
	PublishedAt *string `json:"publishedAt"`
	Error       *string `json:"error"`
}

// UpdateRun is the last (or current) update of the instance.
type UpdateRun struct {
	ID         string  `json:"id"`
	State      string  `json:"state"` // backing-up, running, success, failed, rolled-back
	From       string  `json:"from"`
	To         string  `json:"to"`
	StartedAt  string  `json:"startedAt"`
	FinishedAt *string `json:"finishedAt"`
	Log        string  `json:"log"`
}

// UpdateStatus is GET /instance/updates.
type UpdateStatus struct {
	Version string       `json:"version"`
	Check   *UpdateCheck `json:"check"`
	Run     *UpdateRun   `json:"run"`
}

type InstanceBackup struct {
	ID         string  `json:"id"`
	CreatedAt  string  `json:"createdAt"`
	FinishedAt *string `json:"finishedAt"`
	Status     string  `json:"status"` // running, success, failed
	Trigger    string  `json:"trigger"`
	Filename   *string `json:"filename"`
	Size       *int64  `json:"size"`
	S3Status   *string `json:"s3Status"`
	Error      *string `json:"error"`
	Version    string  `json:"version"`
}

// GetRaw fetches one field of an answer ({"<key>": ...}) both as raw JSON (for --json) and decoded.
func (c *Client) GetRaw(ctx context.Context, path, key string, out any) (json.RawMessage, error) {
	var r map[string]json.RawMessage
	if err := c.Get(ctx, path, nil, &r); err != nil {
		return nil, err
	}
	raw := r[key]
	if len(raw) == 0 {
		raw = json.RawMessage("null")
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			return nil, err
		}
	}
	return raw, nil
}
