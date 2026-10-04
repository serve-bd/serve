package api

import (
	"context"
	"errors"
	"io"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

type buildLog struct {
	Status string `json:"status"`
	Logs   string `json:"logs"`
	Offset *int   `json:"offset"`
}

// FollowOptions tune FollowBuild.
type FollowOptions struct {
	Interval time.Duration
	// OnStatus is called when the status changes (also for the first one).
	OnStatus func(status string)
	// GiveUpAfter is how long failing requests are retried before the follow stops.
	GiveUpAfter time.Duration
}

// FollowBuild writes the build log of a deployment to w as it grows, until the deployment ends
// or ctx is done. It asks only for the new part of the log (offset); against a server that
// answers the whole log every time, it prints only what it has not printed yet.
func (c *Client) FollowBuild(ctx context.Context, deploymentID string, w io.Writer, opts FollowOptions) (string, error) {
	if opts.Interval == 0 {
		opts.Interval = time.Second
	}
	if opts.GiveUpAfter == 0 {
		opts.GiveUpAfter = 2 * time.Minute
	}
	offset := 0
	printed := 0 // for servers without offset support
	status := ""
	seen := "" // the end of what was printed
	write := func(text string) {
		io.WriteString(w, text)
		seen += text
		if len(seen) > 2048 {
			seen = seen[len(seen)-2048:]
		}
	}
	var failingSince time.Time
	for {
		q := url.Values{}
		if offset > 0 {
			q.Set("offset", strconv.Itoa(offset))
		}
		var r buildLog
		err := c.Get(ctx, "/deployments/"+P(deploymentID)+"/logs", q, &r)
		if err != nil {
			if ctx.Err() != nil {
				return status, ctx.Err()
			}
			if !Retryable(err) {
				return status, err
			}
			if failingSince.IsZero() {
				failingSince = time.Now()
			} else if time.Since(failingSince) > opts.GiveUpAfter {
				return status, err
			}
		} else {
			failingSince = time.Time{}
			if r.Offset != nil {
				text := r.Logs
				if *r.Offset < offset {
					// The server dropped the start of a very long log and sent all of what is
					// left: print only what follows the last text already printed.
					text = afterOverlap(seen, text)
				}
				write(text)
				offset = *r.Offset
			} else if len(r.Logs) >= printed {
				write(r.Logs[printed:])
				printed = len(r.Logs)
			}
			if r.Status != status {
				status = r.Status
				if opts.OnStatus != nil {
					opts.OnStatus(status)
				}
			}
			if Terminal(status) {
				return status, nil
			}
		}
		select {
		case <-ctx.Done():
			return status, ctx.Err()
		case <-time.After(opts.Interval):
		}
	}
}

// Retryable is a failure worth trying again: no answer, a server error or too many requests.
func Retryable(err error) bool {
	var ne *NetworkError
	if errors.As(err, &ne) {
		return true
	}
	var ae *Error
	if errors.As(err, &ae) {
		switch ae.Status {
		case 429, 500, 502, 504:
			return true
		case 503:
			// Not when the API is turned off: that does not pass by waiting.
			return !strings.Contains(ae.Message, "API is turned off")
		}
	}
	return false
}

// LogLine is one line of a container's log.
type LogLine struct {
	Container string
	Time      time.Time
	Text      string
}

// SplitTimestamp splits a docker log line "2024-01-01T00:00:00.000000000Z text".
func SplitTimestamp(line string) (time.Time, string) {
	ts, rest, ok := strings.Cut(line, " ")
	if !ok {
		ts = line
	}
	t, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return time.Time{}, line
	}
	return t, rest
}

// ServiceLogs reads the last lines of each running container, after since when not zero, merged by time.
func (c *Client) ServiceLogs(ctx context.Context, serviceID string, tail int, since time.Time) ([]LogLine, error) {
	q := url.Values{"tail": {strconv.Itoa(max(10, min(tail, 5000)))}}
	if !since.IsZero() {
		q.Set("since", since.UTC().Format(time.RFC3339Nano))
	}
	var r struct{ Containers []ContainerLogs }
	if err := c.Get(ctx, "/services/"+P(serviceID)+"/logs", q, &r); err != nil {
		return nil, err
	}
	var lines []LogLine
	for _, ct := range r.Containers {
		for _, l := range ct.Lines {
			t, text := SplitTimestamp(l)
			lines = append(lines, LogLine{Container: ct.Name, Time: t, Text: text})
		}
	}
	sort.SliceStable(lines, func(i, j int) bool { return lines[i].Time.Before(lines[j].Time) })
	return lines, nil
}

// FollowServiceLogs prints the last tail lines and then new lines as they come, polling with since.
// Lines at the same instant as the last one seen are told apart by their text, so none repeats.
func (c *Client) FollowServiceLogs(ctx context.Context, serviceID string, tail int, interval time.Duration, emit func(LogLine)) error {
	lines, err := c.ServiceLogs(ctx, serviceID, tail, time.Time{})
	if err != nil {
		return err
	}
	if len(lines) > tail {
		lines = lines[len(lines)-tail:]
	}
	var last time.Time
	seen := map[string]bool{}
	take := func(ls []LogLine) {
		for _, l := range ls {
			key := l.Container + "\x00" + l.Text
			switch {
			case l.Time.Before(last):
				continue
			case l.Time.Equal(last):
				if seen[key] {
					continue
				}
			default:
				last = l.Time
				seen = map[string]bool{}
			}
			seen[key] = true
			emit(l)
		}
	}
	take(lines)
	var failingSince time.Time
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(interval):
		}
		since := last
		if since.IsZero() {
			since = time.Now().Add(-interval)
		}
		ls, err := c.ServiceLogs(ctx, serviceID, 5000, since)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			if !Retryable(err) {
				return err
			}
			if failingSince.IsZero() {
				failingSince = time.Now()
			} else if time.Since(failingSince) > 2*time.Minute {
				return err
			}
			continue
		}
		failingSince = time.Time{}
		take(ls)
	}
}

// afterOverlap answers the part of text after what was already printed: text starts with the
// end of the old log (or contains all of seen), then goes on with new lines.
func afterOverlap(seen, text string) string {
	if seen == "" {
		return text
	}
	if i := strings.LastIndex(text, seen); i >= 0 {
		return text[i+len(seen):]
	}
	for k := min(len(seen), len(text)); k >= min(16, len(seen)); k-- {
		if strings.HasPrefix(text, seen[len(seen)-k:]) {
			return text[k:]
		}
	}
	return text
}
