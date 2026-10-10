package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
)

// Files on a server (/servers/{id}) or in a service's container (/services/{id}), see
// src/server/api/routes/files.ts. Base is that path; Query carries ?container= and ?replica=.

// FileEntry is one entry of a folder.
type FileEntry struct {
	Name  string `json:"name"`
	Type  string `json:"type"` // dir, file, link, other
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"` // ms
	Mode  string `json:"mode"`  // rwxr-xr-x
	Owner string `json:"owner"`
	Group string `json:"group"`
	Link  *struct {
		Target string `json:"target"`
		Kind   string `json:"kind"` // dir, file, missing
	} `json:"link,omitempty"`
}

// FileMount is a volume or folder mounted into a container.
type FileMount struct {
	Path string `json:"path"`
	Kind string `json:"kind"`
	Name string `json:"name"`
}

// FileListing is a folder: its resolved path and entries.
type FileListing struct {
	Path    string      `json:"path"`
	Entries []FileEntry `json:"entries"`
	Mounts  []FileMount `json:"mounts"`
}

func withPath(q url.Values, p string) url.Values {
	out := url.Values{}
	for k, v := range q {
		out[k] = v
	}
	out.Set("path", p)
	return out
}

// ListFiles lists a folder; raw is the answer as sent (for --json).
func (c *Client) ListFiles(ctx context.Context, base string, q url.Values, p string) (*FileListing, json.RawMessage, error) {
	var raw json.RawMessage
	if err := c.Get(ctx, base+"/files", withPath(q, p), &raw); err != nil {
		return nil, nil, err
	}
	var l FileListing
	if err := json.Unmarshal(raw, &l); err != nil {
		return nil, nil, err
	}
	return &l, raw, nil
}

// UploadFile streams body into the file at p. replace overwrites an existing file.
func (c *Client) UploadFile(ctx context.Context, base string, q url.Values, p string, body io.Reader, size int64, replace bool) error {
	q = withPath(q, p)
	if replace {
		q.Set("replace", "1")
	}
	if size == 0 {
		body = http.NoBody
	}
	return c.Do(ctx, Request{Method: http.MethodPut, Path: base + "/files/content", Query: q, Body: body, Length: size, ContentType: "application/octet-stream"}, nil)
}

// UploadArchive streams a .tar.gz that the server unpacks into the existing folder p. Without
// replace, it fails with 409 when a top-level entry already exists there; with it, it merges.
func (c *Client) UploadArchive(ctx context.Context, base string, q url.Values, p string, body io.Reader, replace bool) error {
	q = withPath(q, p)
	q.Set("extract", "1")
	if replace {
		q.Set("replace", "1")
	}
	return c.Do(ctx, Request{Method: http.MethodPut, Path: base + "/files/content", Query: q, Body: body, ContentType: "application/gzip"}, nil)
}

// FilesChange creates a folder ({op:"mkdir",path}), moves or deletes.
func (c *Client) FilesChange(ctx context.Context, base string, q url.Values, body map[string]string) error {
	return c.Do(ctx, Request{Method: http.MethodPost, Path: base + "/files", Query: q, JSON: body}, nil)
}

// OpenFile starts a download: the caller reads and closes the answer's body. A folder comes as a
// .tar.gz (Content-Type application/gzip); Content-Disposition carries the name.
func (c *Client) OpenFile(ctx context.Context, base string, q url.Values, p string) (*http.Response, error) {
	res, err := c.send(ctx, Request{Method: http.MethodGet, Path: base + "/files/content", Query: withPath(q, p)})
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 300 {
		defer res.Body.Close()
		err := decode(res, nil)
		var ae *Error
		if errors.As(err, &ae) {
			ae.URL = c.BaseURL
		}
		return nil, err
	}
	return res, nil
}
