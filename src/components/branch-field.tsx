"use client";

import useSWR from "swr";
import { RefreshCw } from "lucide-react";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { fetchBranches } from "@/server/actions/integrations";
import { useDebounced } from "@/hooks/use-client";

/** Branch of a repository: a searchable list of its real branches, or a text field when they cannot be read. */
export function BranchField({ repository, credentialId, value, onChange }: { repository: string; credentialId: string | null; value: string; onChange: (branch: string) => void }) {
  // Looked up once the address stops changing: each lookup runs git on the server.
  const repo = useDebounced(repository.trim(), 500);
  const { data, error, isLoading, mutate } = useSWR(
    repo ? ["branches", repo, credentialId] : null,
    async () => {
      const res = await fetchBranches(repo, credentialId);
      if (!res.ok) throw new Error(res.error);
      return res.data;
    },
    // Another repository's branches are never shown while this one loads.
    { revalidateOnFocus: false, shouldRetryOnError: false, keepPreviousData: false },
  );

  if (!data || error) {
    return (
      <div className="flex flex-col gap-1.5">
        <Input value={value} onChange={(e) => onChange(e.target.value.trim())} className="font-mono text-[13px]" placeholder="main" />
        <span className="flex items-center gap-1.5 text-xs text-muted">
          {isLoading ? (
            "Loading branches…"
          ) : error ? (
            <>
              {(error as Error).message}
              <button type="button" onClick={() => void mutate()} className="inline-flex items-center gap-1 text-accent hover:underline">
                <RefreshCw className="size-3" /> Retry
              </button>
            </>
          ) : null}
        </span>
      </div>
    );
  }
  const missing = !!value && !data.includes(value);
  const options = [...(missing ? [value] : []), ...data].map((b) => ({ value: b, label: b, description: b === value && missing ? "Not found in the repository" : undefined }));
  return (
    <div className="flex flex-col gap-1.5">
      <Combobox value={value || null} onValueChange={onChange} options={options} placeholder="Search branches…" />
      {missing && <span className="text-xs text-warn">{value} is not a branch of this repository. Deploys will fail until you pick another.</span>}
    </div>
  );
}
