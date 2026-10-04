package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeBuild serves a build log that grows by one chunk per request and ends after the last chunk.
type fakeBuild struct {
	mu        sync.Mutex
	chunks    []string
	served    int
	offsets   []string
	noOffset  bool
	failAt    int // answer 500 on this request number (1-based), once
	requests  int
	finalStat string
}

func (f *fakeBuild) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests++
	if r.Header.Get("Authorization") != "Bearer tok" {
		w.WriteHeader(401)
		return
	}
	if f.requests == f.failAt {
		w.WriteHeader(500)
		w.Write([]byte(`{"error":"boom"}`))
		return
	}
	if !strings.HasSuffix(r.URL.Path, "/api/v1/deployments/d1/logs") {
		w.WriteHeader(404)
		w.Write([]byte(`{"error":"Deployment not found"}`))
		return
	}
	f.offsets = append(f.offsets, r.URL.Query().Get("offset"))
	if f.served < len(f.chunks) {
		f.served++
	}
	full := strings.Join(f.chunks[:f.served], "")
	status := "building"
	if f.served == len(f.chunks) {
		status = f.finalStat
	}
	off, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	body := map[string]any{"status": status}
	if f.noOffset {
		body["logs"] = full
	} else {
		body["logs"] = full[min(off, len(full)):]
		body["offset"] = len(full)
	}
	json.NewEncoder(w).Encode(body)
}

func TestFollowBuild(t *testing.T) {
	for _, noOffset := range []bool{false, true} {
		f := &fakeBuild{chunks: []string{"Step 1\n", "Step 2\nStep ", "3\n", "Done\n"}, finalStat: "success", noOffset: noOffset, failAt: 3}
		srv := httptest.NewServer(f)
		c := New(srv.URL, "tok", "test")
		var out strings.Builder
		var statuses []string
		status, err := c.FollowBuild(context.Background(), "d1", &out, FollowOptions{Interval: time.Millisecond, OnStatus: func(s string) { statuses = append(statuses, s) }})
		srv.Close()
		if err != nil {
			t.Fatal(err)
		}
		if status != "success" {
			t.Fatalf("status %s", status)
		}
		if out.String() != "Step 1\nStep 2\nStep 3\nDone\n" {
			t.Fatalf("noOffset=%v: log printed as %q", noOffset, out.String())
		}
		if strings.Join(statuses, ",") != "building,success" {
			t.Fatalf("statuses %v", statuses)
		}
		if !noOffset {
			// The first request has no offset; later ones ask from where the last answer ended.
			if f.offsets[0] != "" || f.offsets[1] != "7" {
				t.Fatalf("offsets %v", f.offsets)
			}
		}
	}
}

func TestFollowBuildFailed(t *testing.T) {
	f := &fakeBuild{chunks: []string{"error: no Dockerfile\n"}, finalStat: "failed"}
	srv := httptest.NewServer(f)
	defer srv.Close()
	status, err := New(srv.URL, "tok", "test").FollowBuild(context.Background(), "d1", &strings.Builder{}, FollowOptions{Interval: time.Millisecond})
	if err != nil || status != "failed" {
		t.Fatalf("%s %v", status, err)
	}
}

func TestFollowBuildErrors(t *testing.T) {
	f := &fakeBuild{chunks: []string{"x"}, finalStat: "success"}
	srv := httptest.NewServer(f)
	defer srv.Close()
	_, err := New(srv.URL, "tok", "test").FollowBuild(context.Background(), "missing", &strings.Builder{}, FollowOptions{Interval: time.Millisecond})
	if !IsStatus(err, 404) || err.Error() != "Deployment not found" {
		t.Fatalf("a 404 should stop at once: %v", err)
	}
	_, err = New(srv.URL, "bad", "test").FollowBuild(context.Background(), "d1", &strings.Builder{}, FollowOptions{Interval: time.Millisecond})
	if !IsStatus(err, 401) || !strings.Contains(err.Error(), "serve login") {
		t.Fatalf("a 401 should say to log in: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := New(srv.URL, "tok", "test").FollowBuild(ctx, "d1", &strings.Builder{}, FollowOptions{}); err != context.Canceled {
		t.Fatalf("cancelled: %v", err)
	}
}

func TestFollowServiceLogs(t *testing.T) {
	base := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	ts := func(s int) string { return base.Add(time.Duration(s) * time.Second).Format(time.RFC3339Nano) }
	var mu sync.Mutex
	calls := 0
	var sinces []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		calls++
		sinces = append(sinces, r.URL.Query().Get("since"))
		var lines []string
		switch calls {
		case 1:
			lines = []string{ts(1) + " a", ts(2) + " b", ts(3) + " c"}
		case 2:
			// The server repeats the line at the since instant; it must not print twice.
			lines = []string{ts(3) + " c", ts(3) + " c2", ts(4) + " d"}
		default:
			lines = []string{ts(4) + " d"}
		}
		json.NewEncoder(w).Encode(map[string]any{"containers": []map[string]any{{"id": "1", "name": "web-1", "state": "running", "lines": lines}}})
	}))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	var got []string
	err := New(srv.URL, "tok", "test").FollowServiceLogs(ctx, "s1", 2, time.Millisecond, func(l LogLine) {
		got = append(got, l.Text)
		if l.Text == "d" {
			go func() { time.Sleep(20 * time.Millisecond); cancel() }()
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, ",") != "b,c,c2,d" {
		t.Fatalf("lines %v", got)
	}
	// The fake server may still be answering a last poll: read what it saw under its lock.
	mu.Lock()
	seen := append([]string(nil), sinces...)
	mu.Unlock()
	if seen[0] != "" || seen[1] != ts(3) {
		t.Fatalf("since %v", seen[:2])
	}
}

func TestErrorMessages(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/forbidden":
			w.WriteHeader(403)
			w.Write([]byte(`{"error":"This token cannot do this. It needs: services.deploy."}`))
		case "/api/v1/html":
			w.Write([]byte("<html>login</html>"))
		default:
			w.WriteHeader(401)
			w.Write([]byte(`{"error":"Invalid or missing API token"}`))
		}
	}))
	defer srv.Close()
	c := New(srv.URL, "tok", "test")
	if err := c.Get(context.Background(), "/forbidden", nil, &struct{}{}); err == nil || !strings.Contains(err.Error(), "services.deploy") {
		t.Fatalf("403: %v", err)
	}
	if err := c.Get(context.Background(), "/html", nil, &struct{}{}); err == nil || !strings.Contains(err.Error(), "web page") {
		t.Fatalf("html: %v", err)
	}
	if err := c.Get(context.Background(), "/me", nil, &struct{}{}); err == nil || !strings.Contains(err.Error(), "Run `serve login`") {
		t.Fatalf("401: %v", err)
	}
	dead := New("http://127.0.0.1:1", "tok", "test")
	err := dead.Get(context.Background(), "/me", nil, nil)
	if !Retryable(err) || !strings.Contains(err.Error(), "Cannot reach") {
		t.Fatalf("network: %v", err)
	}
}

func TestFollowBuildShortenedLog(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		switch calls {
		case 1:
			json.NewEncoder(w).Encode(map[string]any{"status": "building", "logs": "Step 1 of 3 done\nStep 2 of 3 done\nStep 3 of 3 running\n", "offset": 54})
		default:
			// The start was dropped: the server answers everything left, from 0, with a smaller offset.
			json.NewEncoder(w).Encode(map[string]any{"status": "success", "logs": "2 of 3 done\nStep 3 of 3 running\nStep 3 of 3 done\n", "offset": 48})
		}
	}))
	defer srv.Close()
	var out strings.Builder
	if _, err := New(srv.URL, "tok", "test").FollowBuild(context.Background(), "d1", &out, FollowOptions{Interval: time.Millisecond}); err != nil {
		t.Fatal(err)
	}
	if out.String() != "Step 1 of 3 done\nStep 2 of 3 done\nStep 3 of 3 running\nStep 3 of 3 done\n" {
		t.Fatalf("printed %q", out.String())
	}
}
