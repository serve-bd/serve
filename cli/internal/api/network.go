package api

// Shapes of the Tailscale, Cloudflare Tunnel, private network and log drain routes.

type Tailnet struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Tailnet   string  `json:"tailnet"`
	AuthType  string  `json:"authType"`
	Tag       string  `json:"tag"`
	DNSSuffix *string `json:"dnsSuffix"`
	Error     *string `json:"error"`
	CheckedAt *string `json:"checkedAt"`
	Servers   []struct {
		ID      string  `json:"id"`
		Name    string  `json:"name"`
		IsLocal bool    `json:"isLocal"`
		Address *string `json:"address"`
		Online  *bool   `json:"online"`
		Only    bool    `json:"only"`
	} `json:"servers"`
}

type TailscaleState struct {
	TailnetID            *string `json:"tailnetId"`
	Tailnet              *string `json:"tailnet"`
	Hostname             *string `json:"hostname"`
	Only                 bool    `json:"only"`
	Joined               bool    `json:"joined"`
	WaitingForJoin       bool    `json:"waitingForJoin"`
	JoinCommandExpiresAt *string `json:"joinCommandExpiresAt"`
	Address              *string `json:"address"`
	DNSName              *string `json:"dnsName"`
	Online               *bool   `json:"online"`
	LastSeen             *string `json:"lastSeen"`
	Error                *string `json:"error"`
}

type Tunnel struct {
	ID            string  `json:"id"`
	AccountID     string  `json:"accountId"`
	ServerID      string  `json:"serverId"`
	ServerName    string  `json:"serverName"`
	Name          string  `json:"name"`
	CfTunnelID    string  `json:"cfTunnelId"`
	Status        string  `json:"status"`
	StatusMessage *string `json:"statusMessage"`
	Dashboard     *string `json:"dashboard"`
	Domains       []struct {
		Hostname    string `json:"hostname"`
		ServiceID   string `json:"serviceId"`
		ServiceName string `json:"serviceName"`
	} `json:"domains"`
	OtherDomains int    `json:"otherDomains"`
	CreatedAt    string `json:"createdAt"`
}

type PrivateNetwork struct {
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	OrganizationID *string `json:"organizationId"`
	Servers        []struct {
		ID     string `json:"id"`
		Name   string `json:"name"`
		Joined bool   `json:"joined"`
	} `json:"servers"`
}

type NetworkServer struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	Joined  bool    `json:"joined"`
	State   *string `json:"state"`
	Message *string `json:"message"`
	Address *string `json:"address"`
	Shared  bool    `json:"shared"`
}

type LogDrain struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Kind       string   `json:"kind"`
	URL        string   `json:"url"`
	Enabled    bool     `json:"enabled"`
	HeaderName *string  `json:"headerName"`
	Username   *string  `json:"username"`
	HasSecret  bool     `json:"hasSecret"`
	ProjectIDs []string `json:"projectIds"`
	ServiceIDs []string `json:"serviceIds"`
	Index      *string  `json:"index"`
	Sourcetype *string  `json:"sourcetype"`
	Insecure   bool     `json:"insecure"`
}
