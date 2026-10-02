// Command serve-agent runs on every remote server of a Serve dashboard. It samples the machine
// (CPU, memory, disk, load) and the containers Serve manages, keeps the samples in memory and
// sends them to the dashboard. When the dashboard cannot be reached, the samples wait (up to a
// day) and are sent once it answers again; the dashboard can also collect them over SSH with
// `serve-agent drain`.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Set at build time.
var version = "dev"

const (
	containerEvery = 5 * time.Second
	maxBuffered    = 2880 // a day of samples at the default interval
	maxPerPush     = 120
	statsWorkers   = 8
)

type Host struct {
	CPU       float64   `json:"cpu"`
	Cores     int       `json:"cores"`
	MemTotal  uint64    `json:"memTotal"`
	MemUsed   uint64    `json:"memUsed"`
	Disk      uint64    `json:"disk"`
	DiskTotal uint64    `json:"diskTotal"`
	Load      []float64 `json:"load"`
	Uptime    float64   `json:"uptime"`
}

type Service struct {
	ID          string  `json:"id"`
	CPU         float64 `json:"cpu"`
	Memory      uint64  `json:"memory"`
	MemoryLimit uint64  `json:"memoryLimit"`
	Rx          uint64  `json:"rx"`
	Tx          uint64  `json:"tx"`
}

type Sample struct {
	Seq      uint64    `json:"seq"`
	T        int64     `json:"t"`
	Host     Host      `json:"host"`
	Services []Service `json:"services"`
}

// Container is the state of one container Serve manages, for status and crash checks.
type Container struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Service      string `json:"service"`
	Deployment   string `json:"deployment,omitempty"`
	State        string `json:"state"`
	RestartCount int    `json:"restartCount"`
	StartedAt    string `json:"startedAt,omitempty"`
	Created      int64  `json:"created"`
	OOMKilled    bool   `json:"oomKilled,omitempty"`
	ExitCode     int    `json:"exitCode"`
}

type Batch struct {
	Boot    string   `json:"boot"`
	Version string   `json:"version"`
	Samples []Sample `json:"samples"`
	// The containers as last checked, and when (ms); nil until the first check.
	Containers   []Container `json:"containers,omitempty"`
	ContainersAt int64       `json:"containersAt,omitempty"`
}

type config struct {
	urls     []string
	token    string
	hostData string
	interval time.Duration
	docker   string
	socket   string
}

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func loadConfig() config {
	interval, err := time.ParseDuration(env("SERVE_INTERVAL", "30s"))
	if err != nil || interval < 5*time.Second {
		interval = 30 * time.Second
	}
	var urls []string
	for _, u := range strings.Split(os.Getenv("SERVE_URLS"), ",") {
		if u = strings.TrimRight(strings.TrimSpace(u), "/"); u != "" {
			urls = append(urls, u)
		}
	}
	return config{
		urls:     urls,
		token:    os.Getenv("SERVE_AGENT_TOKEN"),
		hostData: env("SERVE_HOST_DATA", "/host-data"),
		interval: interval,
		docker:   env("DOCKER_SOCKET", "/var/run/docker.sock"),
		socket:   env("SERVE_AGENT_SOCKET", "/tmp/serve-agent.sock"),
	}
}

func main() {
	cfg := loadConfig()
	if len(os.Args) > 1 && os.Args[1] == "drain" {
		os.Exit(drain(cfg, os.Args[2:]))
	}
	if len(os.Args) > 1 && os.Args[1] == "version" {
		fmt.Println(version)
		return
	}
	a := newAgent(cfg)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	go a.serveLocal(ctx)
	a.run(ctx)
}

/* -------------------------------------------------------------------------- */
/*                                   Buffer                                   */
/* -------------------------------------------------------------------------- */

type agent struct {
	cfg    config
	boot   string
	docker *http.Client
	web    *http.Client

	mu      sync.Mutex
	seq     uint64
	pending []Sample
	// Index into cfg.urls of the address that answered last.
	urlIndex int

	lastCPU   cpuTimes
	lastStats map[string]containerCPU

	// Containers as last checked (under mu); dirty until sent after a change.
	containers   []Container
	containersAt int64
	containerKey string
	dirty        bool
	changed      chan struct{}
}

func newAgent(cfg config) *agent {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return &agent{
		cfg:  cfg,
		boot: hex.EncodeToString(b),
		docker: &http.Client{
			Timeout: 10 * time.Second,
			Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "unix", cfg.docker)
			}},
		},
		web:       &http.Client{Timeout: 15 * time.Second},
		lastStats: map[string]containerCPU{},
		changed:   make(chan struct{}, 1),
	}
}

func (a *agent) add(s Sample) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.seq++
	s.Seq = a.seq
	a.pending = append(a.pending, s)
	if len(a.pending) > maxBuffered {
		a.pending = a.pending[len(a.pending)-maxBuffered:]
	}
}

// clean marks the containers as sent, unless they changed again after that batch was made.
func (a *agent) clean(at int64) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.containersAt == at {
		a.dirty = false
	}
}

// ack drops the samples the dashboard has stored.
func (a *agent) ack(seq uint64) {
	a.mu.Lock()
	defer a.mu.Unlock()
	i := 0
	for i < len(a.pending) && a.pending[i].Seq <= seq {
		i++
	}
	a.pending = a.pending[i:]
}

func (a *agent) batch(max int) Batch {
	a.mu.Lock()
	defer a.mu.Unlock()
	n := len(a.pending)
	if n > max {
		n = max
	}
	samples := make([]Sample, n)
	copy(samples, a.pending[:n])
	return Batch{Boot: a.boot, Version: version, Samples: samples, Containers: a.containers, ContainersAt: a.containersAt}
}

// setContainers stores a check of the containers; it reports whether they changed since the last one.
func (a *agent) setContainers(list []Container, at int64) bool {
	key, _ := json.Marshal(list)
	a.mu.Lock()
	defer a.mu.Unlock()
	a.containersAt = at
	if string(key) == a.containerKey && a.containers != nil {
		return false
	}
	a.containers = list
	a.containerKey = string(key)
	a.dirty = true
	return true
}

/* -------------------------------------------------------------------------- */
/*                                    Loop                                    */
/* -------------------------------------------------------------------------- */

func (a *agent) run(ctx context.Context) {
	fmt.Printf("serve-agent %s: sampling every %s\n", version, a.cfg.interval)
	go a.watchContainers(ctx)
	ticker := time.NewTicker(a.cfg.interval)
	defer ticker.Stop()
	for {
		a.add(a.sample(ctx))
		a.push(ctx)
		if !a.untilTick(ctx, ticker) {
			return
		}
	}
}

// untilTick waits for the next sample, pushing container changes as they happen. False once stopped.
func (a *agent) untilTick(ctx context.Context, ticker *time.Ticker) bool {
	for {
		select {
		case <-ctx.Done():
			return false
		case <-ticker.C:
			return true
		case <-a.changed:
			// A container started, stopped or restarted: tell the dashboard now, not at the next sample.
			a.push(ctx)
		}
	}
}

// watchContainers checks the containers every few seconds and wakes the loop when they change.
func (a *agent) watchContainers(ctx context.Context) {
	t := time.NewTicker(containerEvery)
	defer t.Stop()
	for {
		if list, err := a.listContainers(ctx); err == nil && a.setContainers(list, time.Now().UnixMilli()) {
			select {
			case a.changed <- struct{}{}:
			default:
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

var errGone = errors.New("metrics are turned off for this server")

// push sends what is waiting, in chunks, to the first dashboard address that answers.
func (a *agent) push(ctx context.Context) {
	if len(a.cfg.urls) == 0 || a.cfg.token == "" {
		return
	}
	for round := 0; round < 25; round++ {
		b := a.batch(maxPerPush)
		a.mu.Lock()
		dirty := a.dirty
		a.mu.Unlock()
		if len(b.Samples) == 0 && !dirty {
			return
		}
		ack, err := a.send(ctx, b)
		if errors.Is(err, errGone) {
			if len(b.Samples) > 0 {
				a.ack(b.Samples[len(b.Samples)-1].Seq)
			}
			a.clean(b.ContainersAt)
			return
		}
		if err != nil {
			// Kept for the next round, or for the dashboard to collect over SSH.
			return
		}
		a.ack(ack)
		a.clean(b.ContainersAt)
		if len(b.Samples) == 0 || ack < b.Samples[len(b.Samples)-1].Seq {
			return
		}
	}
}

func (a *agent) send(ctx context.Context, b Batch) (uint64, error) {
	body, err := json.Marshal(b)
	if err != nil {
		return 0, err
	}
	var last error
	for i := range a.cfg.urls {
		idx := (a.urlIndex + i) % len(a.cfg.urls)
		ack, err := a.sendTo(ctx, a.cfg.urls[idx], body)
		if err == nil || errors.Is(err, errGone) {
			a.urlIndex = idx
			return ack, err
		}
		last = err
	}
	return 0, last
}

func (a *agent) sendTo(ctx context.Context, base string, body []byte) (uint64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/agent/metrics", bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+a.cfg.token)
	res, err := a.web.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusGone {
		return 0, errGone
	}
	if res.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(res.Body, 300))
		return 0, fmt.Errorf("%s answered %d: %s", base, res.StatusCode, strings.TrimSpace(string(msg)))
	}
	var out struct {
		Ack uint64 `json:"ack"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<16)).Decode(&out); err != nil {
		return 0, err
	}
	return out.Ack, nil
}

/* -------------------------------------------------------------------------- */
/*                           Collection over SSH                              */
/* -------------------------------------------------------------------------- */

// serveLocal answers `serve-agent drain` inside the container, for dashboards the server cannot reach.
func (a *agent) serveLocal(ctx context.Context) {
	_ = os.Remove(a.cfg.socket)
	ln, err := net.Listen("unix", a.cfg.socket)
	if err != nil {
		fmt.Println("serve-agent: local socket:", err)
		return
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/pending", func(w http.ResponseWriter, r *http.Request) {
		if ack, err := strconv.ParseUint(r.URL.Query().Get("ack"), 10, 64); err == nil && r.URL.Query().Get("boot") == a.boot {
			a.ack(ack)
		}
		max, err := strconv.Atoi(r.URL.Query().Get("max"))
		if err != nil || max <= 0 || max > maxBuffered {
			max = 240
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(a.batch(max))
	})
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		_ = srv.Close()
	}()
	_ = srv.Serve(ln)
}

func drain(cfg config, args []string) int {
	q := url.Values{}
	for i := 0; i+1 < len(args); i += 2 {
		q.Set(strings.TrimLeft(args[i], "-"), args[i+1])
	}
	c := &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", cfg.socket)
		}},
	}
	res, err := c.Get("http://agent/pending?" + q.Encode())
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer res.Body.Close()
	_, _ = io.Copy(os.Stdout, res.Body)
	return 0
}

/* -------------------------------------------------------------------------- */
/*                                  Sampling                                  */
/* -------------------------------------------------------------------------- */

func (a *agent) sample(ctx context.Context) Sample {
	s := Sample{T: time.Now().UnixMilli(), Host: a.host(), Services: a.services(ctx)}
	if s.Services == nil {
		s.Services = []Service{}
	}
	return s
}

type cpuTimes struct{ idle, total uint64 }

// readCPU returns the machine's CPU times and its number of cores (/proc/stat is not namespaced).
func readCPU() (cpuTimes, int) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return cpuTimes{}, 0
	}
	defer f.Close()
	var t cpuTimes
	cores := 0
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "cpu ") {
			fields := strings.Fields(line)[1:]
			for i, v := range fields {
				n, _ := strconv.ParseUint(v, 10, 64)
				t.total += n
				if i == 3 || i == 4 {
					t.idle += n
				}
			}
		} else if strings.HasPrefix(line, "cpu") {
			cores++
		}
	}
	return t, cores
}

func cpuPercent(prev, next cpuTimes) float64 {
	total := float64(next.total - prev.total)
	if total <= 0 || next.total < prev.total {
		return 0
	}
	p := (1 - float64(next.idle-prev.idle)/total) * 100
	return clamp(p, 0, 100)
}

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func (a *agent) host() Host {
	now, cores := readCPU()
	prev := a.lastCPU
	if prev.total == 0 {
		time.Sleep(300 * time.Millisecond)
		prev = now
		now, _ = readCPU()
	}
	a.lastCPU = now
	h := Host{CPU: cpuPercent(prev, now), Cores: cores, Load: []float64{}}

	if b, err := os.ReadFile("/proc/meminfo"); err == nil {
		var total, avail uint64
		for _, line := range strings.Split(string(b), "\n") {
			f := strings.Fields(line)
			if len(f) < 2 {
				continue
			}
			n, _ := strconv.ParseUint(f[1], 10, 64)
			switch f[0] {
			case "MemTotal:":
				total = n * 1024
			case "MemAvailable:":
				avail = n * 1024
			}
		}
		h.MemTotal = total
		if total > avail {
			h.MemUsed = total - avail
		}
	}
	var st syscall.Statfs_t
	if err := syscall.Statfs(a.cfg.hostData, &st); err == nil {
		h.DiskTotal = st.Blocks * uint64(st.Bsize)
		h.Disk = (st.Blocks - st.Bfree) * uint64(st.Bsize)
	}
	if b, err := os.ReadFile("/proc/loadavg"); err == nil {
		for _, v := range strings.Fields(string(b))[:3] {
			n, _ := strconv.ParseFloat(v, 64)
			h.Load = append(h.Load, n)
		}
	}
	if b, err := os.ReadFile("/proc/uptime"); err == nil {
		if f := strings.Fields(string(b)); len(f) > 0 {
			h.Uptime, _ = strconv.ParseFloat(f[0], 64)
		}
	}
	return h
}

type containerCPU struct{ total, system uint64 }

type dockerStats struct {
	CPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemCPUUsage uint64 `json:"system_cpu_usage"`
		OnlineCPUs     int    `json:"online_cpus"`
	} `json:"cpu_stats"`
	MemoryStats struct {
		Usage uint64 `json:"usage"`
		Limit uint64 `json:"limit"`
		Stats struct {
			InactiveFile uint64 `json:"inactive_file"`
			Cache        uint64 `json:"cache"`
		} `json:"stats"`
	} `json:"memory_stats"`
	Networks map[string]struct {
		RxBytes uint64 `json:"rx_bytes"`
		TxBytes uint64 `json:"tx_bytes"`
	} `json:"networks"`
}

func (a *agent) getJSON(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker"+path, nil)
	if err != nil {
		return err
	}
	res, err := a.docker.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("docker answered %d for %s", res.StatusCode, path)
	}
	return json.NewDecoder(res.Body).Decode(out)
}

// listContainers returns every container of a Serve service, running or not. Running and
// restarting ones are inspected for their restart count (the dashboard counts crashes with it).
func (a *agent) listContainers(ctx context.Context) ([]Container, error) {
	var listed []struct {
		ID      string            `json:"Id"`
		Names   []string          `json:"Names"`
		State   string            `json:"State"`
		Created int64             `json:"Created"`
		Labels  map[string]string `json:"Labels"`
	}
	filters := url.QueryEscape(`{"label":["serve.service"]}`)
	if err := a.getJSON(ctx, "/containers/json?all=true&filters="+filters, &listed); err != nil {
		return nil, err
	}
	out := make([]Container, len(listed))
	var wg sync.WaitGroup
	sem := make(chan struct{}, statsWorkers)
	for i, c := range listed {
		name := ""
		if len(c.Names) > 0 {
			name = strings.TrimPrefix(c.Names[0], "/")
		}
		out[i] = Container{ID: c.ID, Name: name, Service: c.Labels["serve.service"], Deployment: c.Labels["serve.deployment"], State: c.State, Created: c.Created}
		if c.State != "running" && c.State != "restarting" {
			continue
		}
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			var info struct {
				RestartCount int `json:"RestartCount"`
				State        struct {
					StartedAt string `json:"StartedAt"`
					OOMKilled bool   `json:"OOMKilled"`
					ExitCode  int    `json:"ExitCode"`
				} `json:"State"`
			}
			if err := a.getJSON(ctx, "/containers/"+id+"/json", &info); err == nil {
				out[i].RestartCount = info.RestartCount
				out[i].StartedAt = info.State.StartedAt
				out[i].OOMKilled = info.State.OOMKilled
				out[i].ExitCode = info.State.ExitCode
			}
		}(i, c.ID)
	}
	wg.Wait()
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// services sums the usage of the running containers Serve manages, per service.
func (a *agent) services(ctx context.Context) []Service {
	var containers []struct {
		ID     string            `json:"Id"`
		Labels map[string]string `json:"Labels"`
	}
	filters := url.QueryEscape(`{"label":["serve.managed=true"]}`)
	if err := a.getJSON(ctx, "/containers/json?filters="+filters, &containers); err != nil {
		return nil
	}
	type result struct {
		id, service string
		stats       dockerStats
	}
	jobs := make(chan int)
	results := make(chan result, len(containers))
	var wg sync.WaitGroup
	for w := 0; w < statsWorkers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				c := containers[i]
				var s dockerStats
				// One-shot: no second sample inside Docker. CPU comes from the change since our last sample.
				if err := a.getJSON(ctx, "/containers/"+c.ID+"/stats?stream=false&one-shot=true", &s); err == nil {
					results <- result{c.ID, c.Labels["serve.service"], s}
				}
			}
		}()
	}
	for i, c := range containers {
		// The dashboard takes service ids of up to 64 characters.
		if id := c.Labels["serve.service"]; id != "" && len(id) <= 64 {
			jobs <- i
		}
	}
	close(jobs)
	wg.Wait()
	close(results)

	seen := map[string]containerCPU{}
	byService := map[string]*Service{}
	var order []string
	for r := range results {
		cur := containerCPU{r.stats.CPUStats.CPUUsage.TotalUsage, r.stats.CPUStats.SystemCPUUsage}
		seen[r.id] = cur
		cpu := 0.0
		if prev, ok := a.lastStats[r.id]; ok && cur.system > prev.system && cur.total >= prev.total {
			cpus := r.stats.CPUStats.OnlineCPUs
			if cpus == 0 {
				cpus = 1
			}
			cpu = float64(cur.total-prev.total) / float64(cur.system-prev.system) * float64(cpus) * 100
		}
		m := r.stats.MemoryStats
		cache := m.Stats.InactiveFile
		if cache == 0 {
			cache = m.Stats.Cache
		}
		mem := uint64(0)
		if m.Usage > cache {
			mem = m.Usage - cache
		}
		svc, ok := byService[r.service]
		if !ok {
			svc = &Service{ID: r.service}
			byService[r.service] = svc
			order = append(order, r.service)
		}
		svc.CPU += cpu
		svc.Memory += mem
		if m.Limit > svc.MemoryLimit {
			svc.MemoryLimit = m.Limit
		}
		for _, n := range r.stats.Networks {
			svc.Rx += n.RxBytes
			svc.Tx += n.TxBytes
		}
	}
	a.lastStats = seen
	out := make([]Service, 0, len(order))
	for _, id := range order {
		out = append(out, *byService[id])
	}
	return out
}
