package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
)

// Listed is a list answer: the items to show, and the API's own JSON of each for --json.
type Listed[T any] struct {
	Items []T
	Raw   []json.RawMessage
}

// List reads the array under key of a GET answer, like {"members": [...]}.
func List[T any](ctx context.Context, c *Client, path, key string, q url.Values) (*Listed[T], error) {
	var body map[string]json.RawMessage
	if err := c.Get(ctx, path, q, &body); err != nil {
		return nil, err
	}
	out := &Listed[T]{Raw: []json.RawMessage{}}
	if raw, ok := body[key]; ok && string(raw) != "null" {
		if err := json.Unmarshal(raw, &out.Raw); err != nil {
			return nil, fmt.Errorf("the server's answer could not be read: %w", err)
		}
	}
	out.Items = make([]T, len(out.Raw))
	for i, r := range out.Raw {
		if err := json.Unmarshal(r, &out.Items[i]); err != nil {
			return nil, fmt.Errorf("the server's answer could not be read: %w", err)
		}
	}
	return out, nil
}

type Organization struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Slug      string  `json:"slug"`
	Logo      *string `json:"logo"`
	Root      bool    `json:"root"`
	CreatedAt string  `json:"createdAt"`
}

type User struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

type Member struct {
	ID         string   `json:"id"`
	User       User     `json:"user"`
	RoleID     string   `json:"roleId"`
	Role       string   `json:"role"`
	ProjectIDs []string `json:"projectIds"`
	JoinedAt   string   `json:"joinedAt"`
}

type Invitation struct {
	ID        string `json:"id"`
	Email     string `json:"email"`
	RoleID    string `json:"roleId"`
	ExpiresAt string `json:"expiresAt"`
	CreatedAt string `json:"createdAt"`
}

type Invited struct {
	ID         *string `json:"id"`
	Added      bool    `json:"added"`
	Emailed    bool    `json:"emailed"`
	EmailError *string `json:"emailError"`
}

type Role struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description *string  `json:"description"`
	Builtin     *string  `json:"builtin"`
	Permissions []string `json:"permissions"`
}

type Permission struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

type Token struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Prefix     string   `json:"prefix"`
	UserID     string   `json:"userId"`
	Granted    []string `json:"granted"`
	ProjectIDs []string `json:"projectIds"`
	ExpiresAt  *string  `json:"expiresAt"`
	LastUsedAt *string  `json:"lastUsedAt"`
	CreatedAt  string   `json:"createdAt"`
}

type Activity struct {
	ID         string  `json:"id"`
	Action     string  `json:"action"`
	Message    string  `json:"message"`
	TargetType *string `json:"targetType"`
	TargetID   *string `json:"targetId"`
	ProjectID  *string `json:"projectId"`
	User       *struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"user"`
	CreatedAt string `json:"createdAt"`
}

type Registry struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Kind      string  `json:"kind"`
	Host      string  `json:"host"`
	Username  string  `json:"username"`
	Namespace *string `json:"namespace"`
	CreatedAt string  `json:"createdAt"`
}

type S3Destination struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Endpoint   string  `json:"endpoint"`
	Region     *string `json:"region"`
	Bucket     string  `json:"bucket"`
	PathPrefix *string `json:"pathPrefix"`
	CreatedAt  string  `json:"createdAt"`
}

type NotificationChannel struct {
	ID                 string   `json:"id"`
	Name               string   `json:"name"`
	Kind               string   `json:"kind"`
	Events             []string `json:"events"`
	Enabled            bool     `json:"enabled"`
	LastDeliveryAt     *string  `json:"lastDeliveryAt"`
	LastDeliveryStatus *string  `json:"lastDeliveryStatus"`
	LastDeliveryError  *string  `json:"lastDeliveryError"`
}

type SecretProvider struct {
	ID     string         `json:"id"`
	Name   string         `json:"name"`
	Kind   string         `json:"kind"`
	Config map[string]any `json:"config"`
	Access *struct {
		ProjectIDs     []string `json:"projectIds"`
		EnvironmentIDs []string `json:"environmentIds"`
	} `json:"access"`
	CreatedAt string `json:"createdAt"`
}

type CloudflareAccount struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Email       *string `json:"email"`
	CFAccountID *string `json:"cfAccountId"`
	CreatedAt   string  `json:"createdAt"`
}

type CloudflareZone struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Status      string   `json:"status"`
	Paused      bool     `json:"paused"`
	NameServers []string `json:"name_servers"`
	Plan        *struct {
		Name string `json:"name"`
	} `json:"plan"`
}

type DNSRecord struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Name     string `json:"name"`
	Content  string `json:"content"`
	Proxied  bool   `json:"proxied"`
	TTL      int    `json:"ttl"`
	Priority *int   `json:"priority"`
}

type GitCredential struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Provider  string  `json:"provider"`
	BaseURL   *string `json:"baseUrl"`
	Info      *string `json:"info"`
	CreatedAt string  `json:"createdAt"`
}

type GitRepo struct {
	FullName      string  `json:"fullName"`
	CloneURL      string  `json:"cloneUrl"`
	DefaultBranch string  `json:"defaultBranch"`
	Private       bool    `json:"private"`
	UpdatedAt     *string `json:"updatedAt"`
	Description   *string `json:"description"`
}
