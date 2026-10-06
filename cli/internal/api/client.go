// Package api talks to the Serve REST API (/api/v1) and the CLI login endpoints (/api/cli).
package api

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type Client struct {
	BaseURL   string // the dashboard address, without /api/v1
	Token     string
	UserAgent string
	HTTP      *http.Client
	// DownHint replaces the message of a request that got no answer (Serve on this machine).
	DownHint string
	// MaxWait caps a Retry-After wait (tests shorten it).
	MaxWait time.Duration
}

func New(baseURL, token, userAgent string) *Client {
	return NewInsecure(baseURL, token, userAgent, false)
}

// NewInsecure makes a client; insecure skips TLS certificate checks (a self-signed dashboard).
// HTTPS_PROXY and NO_PROXY are honored.
func NewInsecure(baseURL, token, userAgent string, insecure bool) *Client {
	return &Client{
		BaseURL:   strings.TrimRight(baseURL, "/"),
		Token:     token,
		UserAgent: userAgent,
		MaxWait:   60 * time.Second,
		// No overall timeout: uploads and log follows run long. Each call passes a context.
		HTTP: &http.Client{CheckRedirect: checkRedirect, Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			TLSHandshakeTimeout:   15 * time.Second,
			TLSClientConfig:       &tls.Config{InsecureSkipVerify: insecure}, //nolint:gosec // only with --insecure
			ResponseHeaderTimeout: 5 * time.Minute,
			IdleConnTimeout:       90 * time.Second,
			MaxIdleConnsPerHost:   4,
		}},
	}
}

// RedirectError is a redirect that was not followed because it would leak the token.
type RedirectError struct{ msg string }

func (e *RedirectError) Error() string { return e.msg }

// checkRedirect refuses a redirect that would carry the token to another host, or from https to
// plain http where anyone on the way could read it.
func checkRedirect(req *http.Request, via []*http.Request) error {
	if len(via) >= 10 {
		return errors.New("stopped after 10 redirects")
	}
	first := via[0]
	if first.Header.Get("Authorization") == "" {
		return nil
	}
	if first.URL.Scheme == "https" && req.URL.Scheme != "https" {
		return &RedirectError{fmt.Sprintf("refused a redirect from %s to %s: it would send your token without HTTPS", first.URL.Scheme+"://"+first.URL.Host, req.URL.Scheme+"://"+req.URL.Host)}
	}
	if !strings.EqualFold(first.URL.Host, req.URL.Host) {
		return &RedirectError{fmt.Sprintf("refused a redirect from %s to %s: it would send your token to another host. Log in with the dashboard's own address", first.URL.Host, req.URL.Host)}
	}
	return nil
}

// Error is an answer of the API that is not a success.
type Error struct {
	Status  int
	Message string
	// Body is the decoded answer, for callers that need more fields (the login poll status).
	Body map[string]any
	// RetryAfter is the wait a 429 or 503 answer asked for.
	RetryAfter time.Duration
	// URL is the dashboard that answered.
	URL string
}

func (e *Error) Error() string {
	switch e.Status {
	case http.StatusUnauthorized:
		msg := "You are not logged in, or your login has expired or was revoked. Run `serve login` to log in again."
		if e.Message != "" && !strings.EqualFold(e.Message, "Unauthorized") && !strings.Contains(e.Message, "missing API token") {
			msg = e.Message + ". Run `serve login` to log in again."
		}
		return msg
	case http.StatusTooManyRequests:
		return "Too many requests. Wait a minute and try again. (" + e.Message + ")"
	case http.StatusServiceUnavailable:
		if strings.Contains(e.Message, "API is turned off") {
			return "The API is turned off in Settings → Security on " + e.URL + ". An admin can turn it on there"
		}
	}
	if e.Message != "" {
		return e.Message
	}
	return fmt.Sprintf("The server answered %d %s.", e.Status, http.StatusText(e.Status))
}

// IsStatus says whether err is an API error with this status.
func IsStatus(err error, status int) bool {
	var e *Error
	return errors.As(err, &e) && e.Status == status
}

// NetworkError is a request that never got an answer.
type NetworkError struct {
	URL  string
	Err  error
	Hint string
}

func (e *NetworkError) Error() string {
	if e.Hint != "" {
		return e.Hint
	}
	var cert *tls.CertificateVerificationError
	if errors.As(e.Err, &cert) {
		return fmt.Sprintf("Cannot reach %s: its HTTPS certificate is not trusted (%v). For a self-signed certificate, pass --insecure or set SERVE_INSECURE=1", e.URL, cert.Err)
	}
	return fmt.Sprintf("Cannot reach %s: %v", e.URL, unwrapNet(e.Err))
}

func (e *NetworkError) Unwrap() error { return e.Err }

func unwrapNet(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	var oe *net.OpError
	if errors.As(err, &oe) && oe.Err != nil {
		return oe.Err
	}
	return err
}

// Request is one call. Path is relative to /api/v1 unless it starts with /api/.
type Request struct {
	Method      string
	Path        string
	Query       url.Values
	JSON        any
	Body        io.Reader
	ContentType string
	Length      int64
	// NoRetry returns a 429 to the caller instead of waiting it out.
	NoRetry bool
	// Header adds request headers (a secret that must not go in the URL, say).
	Header http.Header
}

// Do sends the request and decodes a JSON answer into out (when not nil). A 429 answer is tried
// again after its Retry-After wait (up to three times) when the body can be sent again.
func (c *Client) Do(ctx context.Context, r Request, out any) error {
	for attempt := 0; ; attempt++ {
		res, err := c.send(ctx, r)
		if err != nil {
			return err
		}
		err = decode(res, out)
		res.Body.Close()
		var ae *Error
		if !errors.As(err, &ae) {
			return err
		}
		ae.URL = c.BaseURL
		if ae.Status != http.StatusTooManyRequests || attempt >= 3 || r.Body != nil || r.NoRetry {
			return err
		}
		wait := min(max(ae.RetryAfter, time.Second), c.MaxWait)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
	}
}

func retryAfter(h string) time.Duration {
	if n, err := strconv.Atoi(strings.TrimSpace(h)); err == nil && n >= 0 {
		return time.Duration(n) * time.Second
	}
	if t, err := http.ParseTime(h); err == nil {
		return time.Until(t)
	}
	return 0
}

func (c *Client) url(r Request) string {
	p := r.Path
	if !strings.HasPrefix(p, "/api/") {
		p = "/api/v1" + p
	}
	u := c.BaseURL + p
	if len(r.Query) > 0 {
		u += "?" + r.Query.Encode()
	}
	return u
}

func (c *Client) send(ctx context.Context, r Request) (*http.Response, error) {
	body := r.Body
	ctype := r.ContentType
	if r.JSON != nil {
		b, err := json.Marshal(r.JSON)
		if err != nil {
			return nil, err
		}
		body = bytes.NewReader(b)
		ctype = "application/json"
	}
	u := c.url(r)
	req, err := http.NewRequestWithContext(ctx, r.Method, u, body)
	if err != nil {
		return nil, err
	}
	if r.Length > 0 {
		req.ContentLength = r.Length
	}
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	for k, v := range r.Header {
		req.Header[k] = v
	}
	req.Header.Set("Accept", "application/json")
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		var re *RedirectError
		if errors.As(err, &re) {
			return nil, re
		}
		return nil, &NetworkError{URL: c.BaseURL, Err: err, Hint: c.DownHint}
	}
	return res, nil
}

func decode(res *http.Response, out any) error {
	b, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
	if err != nil {
		return err
	}
	if res.StatusCode >= 300 {
		e := &Error{Status: res.StatusCode, RetryAfter: retryAfter(res.Header.Get("Retry-After"))}
		var m map[string]any
		if json.Unmarshal(b, &m) == nil {
			e.Body = m
			if s, ok := m["error"].(string); ok {
				e.Message = s
			} else if s, ok := m["message"].(string); ok {
				e.Message = s
			}
		} else if res.StatusCode == http.StatusNotFound && bytes.Contains(b, []byte("<html")) {
			e.Message = "Not found. Is this the address of a Serve dashboard, and is it up to date?"
		}
		return e
	}
	if out == nil || len(bytes.TrimSpace(b)) == 0 {
		return nil
	}
	if err := json.Unmarshal(b, out); err != nil {
		if bytes.HasPrefix(bytes.TrimSpace(b), []byte("<")) {
			return errors.New("the server answered with a web page instead of JSON. Is this the address of a Serve dashboard?")
		}
		return fmt.Errorf("the server's answer could not be read: %w", err)
	}
	return nil
}

func (c *Client) Get(ctx context.Context, path string, q url.Values, out any) error {
	return c.Do(ctx, Request{Method: http.MethodGet, Path: path, Query: q}, out)
}

func (c *Client) Post(ctx context.Context, path string, body any, out any) error {
	if body == nil {
		body = struct{}{}
	}
	return c.Do(ctx, Request{Method: http.MethodPost, Path: path, JSON: body}, out)
}

func (c *Client) Patch(ctx context.Context, path string, body any, out any) error {
	return c.Do(ctx, Request{Method: http.MethodPatch, Path: path, JSON: body}, out)
}

func (c *Client) Delete(ctx context.Context, path string, q url.Values, out any) error {
	return c.Do(ctx, Request{Method: http.MethodDelete, Path: path, Query: q}, out)
}

// P escapes one path segment.
func P(s string) string { return url.PathEscape(s) }

// Download streams a raw answer (a file) into w and returns its headers.
func (c *Client) Download(ctx context.Context, path string, w io.Writer) (http.Header, error) {
	res, err := c.send(ctx, Request{Method: http.MethodGet, Path: path})
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		err := decode(res, nil)
		var ae *Error
		if errors.As(err, &ae) {
			ae.URL = c.BaseURL
		}
		return nil, err
	}
	if _, err := io.Copy(w, res.Body); err != nil {
		return nil, err
	}
	return res.Header, nil
}
