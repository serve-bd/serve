import { cn } from "@/lib/utils";

/** Read-only monospace code with line numbers. */
export function CodeView({ code, className, maxHeight = "60vh" }: { code: string; className?: string; maxHeight?: string }) {
  const lines = code.replace(/\n$/, "").split("\n");
  const width = String(lines.length).length;
  return (
    <div className={cn("scrollbar-thin overflow-auto rounded-xl bg-log-bg py-3 font-mono text-[12px] leading-relaxed text-log-fg", className)} style={{ maxHeight }}>
      <table className="border-collapse">
        <tbody>
          {lines.map((line, i) => (
            <tr key={i}>
              <td className="pr-4 pl-4 text-right align-top opacity-40 select-none" style={{ minWidth: `${width + 3}ch` }}>
                {i + 1}
              </td>
              <td className="pr-4 whitespace-pre">{line || " "}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
