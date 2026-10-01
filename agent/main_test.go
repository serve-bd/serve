package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestBufferKeepsNewestAndAcks(t *testing.T) {
	a := newAgent(config{})
	for i := 0; i < maxBuffered+10; i++ {
		a.add(Sample{})
	}
	b := a.batch(maxBuffered + 100)
	if len(b.Samples) != maxBuffered || b.Samples[0].Seq != 11 {
		t.Fatalf("want the newest %d samples from seq 11, got %d from %d", maxBuffered, len(b.Samples), b.Samples[0].Seq)
	}
	a.ack(20)
	if got := a.batch(1).Samples[0].Seq; got != 21 {
		t.Fatalf("after ack 20 want seq 21 first, got %d", got)
	}
}

func TestCPUPercent(t *testing.T) {
	if got := cpuPercent(cpuTimes{idle: 100, total: 200}, cpuTimes{idle: 150, total: 300}); got != 50 {
		t.Fatalf("want 50, got %v", got)
	}
	// A counter that went backwards (a reboot) is not a negative load.
	if got := cpuPercent(cpuTimes{idle: 100, total: 200}, cpuTimes{idle: 1, total: 2}); got != 0 {
		t.Fatalf("want 0, got %v", got)
	}
}

func TestPushFallsBackAndKeepsSamplesWhileDown(t *testing.T) {
	var up atomic.Bool
	var received atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !up.Load() {
			http.Error(w, "down", http.StatusBadGateway)
			return
		}
		if r.Header.Get("Authorization") != "Bearer s1.tok" {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		var b Batch
		_ = json.NewDecoder(r.Body).Decode(&b)
		received.Add(int64(len(b.Samples)))
		_ = json.NewEncoder(w).Encode(map[string]uint64{"ack": b.Samples[len(b.Samples)-1].Seq})
	}))
	defer srv.Close()

	a := newAgent(config{urls: []string{"http://127.0.0.1:1", srv.URL}, token: "s1.tok"})
	for i := 0; i < 3; i++ {
		a.add(Sample{})
		a.push(context.Background())
	}
	if n := len(a.batch(maxBuffered).Samples); n != 3 {
		t.Fatalf("while the dashboard is down all 3 samples wait, got %d", n)
	}
	up.Store(true)
	a.add(Sample{})
	a.push(context.Background())
	if received.Load() != 4 || len(a.batch(maxBuffered).Samples) != 0 {
		t.Fatalf("want 4 sent and none waiting, got %d sent and %d waiting", received.Load(), len(a.batch(maxBuffered).Samples))
	}
}

func TestGoneDropsSamples(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusGone)
	}))
	defer srv.Close()
	a := newAgent(config{urls: []string{srv.URL}, token: "x.y"})
	a.add(Sample{})
	a.push(context.Background())
	if n := len(a.batch(10).Samples); n != 0 {
		t.Fatalf("metrics off: samples are dropped, %d left", n)
	}
}
