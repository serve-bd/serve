/*
 * The Prometheus text exposition format (version 0.0.4): one HELP and one TYPE line per metric,
 * then its samples. Pure, so the format is tested without a database.
 */

export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

export type MetricType = "gauge" | "counter";
export type Labels = Record<string, string | number | null | undefined>;

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** A label value inside double quotes: backslash, double quote and line feed are escaped. */
export function escapeLabelValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** HELP text: backslash and line feed are escaped (quotes stay as they are). */
export function escapeHelp(text: string) {
  return text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

export function formatValue(value: number) {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  return String(value);
}

function formatLabels(labels: Labels) {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(labels)) {
    if (value === null || value === undefined) continue;
    if (!LABEL_NAME.test(name) || name.startsWith("__")) throw new Error(`Invalid label name ${name}`);
    parts.push(`${name}="${escapeLabelValue(String(value))}"`);
  }
  return parts.length ? `{${parts.join(",")}}` : "";
}

type Family = { name: string; type: MetricType; help: string; samples: string[] };

/** Collects metric families in the order they are first declared and renders them. */
export class Exposition {
  private families = new Map<string, Family>();

  private family(name: string, type: MetricType, help: string) {
    if (!NAME.test(name)) throw new Error(`Invalid metric name ${name}`);
    if (type === "counter" && !name.endsWith("_total")) throw new Error(`Counter ${name} must end in _total`);
    let f = this.families.get(name);
    if (!f) {
      f = { name, type, help, samples: [] };
      this.families.set(name, f);
    } else if (f.type !== type) throw new Error(`${name} is already a ${f.type}`);
    return f;
  }

  /** Declares a gauge; samples without a finite or explicit NaN value are skipped. */
  gauge(name: string, help: string) {
    return this.adder(this.family(name, "gauge", help));
  }

  counter(name: string, help: string) {
    return this.adder(this.family(name, "counter", help));
  }

  private adder(f: Family) {
    const add = (labels: Labels, value: number | null | undefined) => {
      if (value === null || value === undefined) return add;
      if (f.type === "counter" && !(value >= 0)) return add;
      f.samples.push(`${f.name}${formatLabels(labels)} ${formatValue(value)}`);
      return add;
    };
    return add;
  }

  /** The exposition text. Families without samples are left out. Ends with a line feed. */
  render() {
    const out: string[] = [];
    for (const f of this.families.values()) {
      if (!f.samples.length) continue;
      out.push(`# HELP ${f.name} ${escapeHelp(f.help)}`, `# TYPE ${f.name} ${f.type}`, ...f.samples);
    }
    return out.length ? `${out.join("\n")}\n` : "";
  }
}
