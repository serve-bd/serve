"use client";

import * as React from "react";
import Link from "next/link";
import { Blocks, Plus } from "lucide-react";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { buttonVariants } from "@/components/ui/button";
import { Card, EmptyState } from "@/components/ui/misc";
import { ViewToggle } from "@/components/view-toggle";
import { ProjectCard, ProjectRow, type ProjectSummary } from "../_components/project-card";

/** Remembers the chosen view; the page reads it on the server, so the first paint is already right. */
const VIEW_COOKIE = "serve-projects-view";

export type ProjectsViewMode = "grid" | "list";

export function ProjectsScreen({ projects, initialView, canCreate }: { projects: ProjectSummary[]; initialView: ProjectsViewMode; canCreate: boolean }) {
  const [view, setView] = React.useState(initialView);
  const choose = (v: ProjectsViewMode) => {
    setView(v);
    // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is missing in older Safari and Firefox
    document.cookie = `${VIEW_COOKIE}=${v}; path=/; max-age=31536000; samesite=lax`;
  };
  const newButton = (
    <Link href="/projects/new" className={buttonVariants({ variant: "primary", size: "sm" })} hidden={!canCreate}>
      <Plus /> New project
    </Link>
  );
  return (
    <>
      <PageHeader
        title="Projects"
        description="Each project holds apps, databases and services that belong together, with separate environments."
        actions={
          <>
            {projects.length > 0 && <ViewToggle view={view} views={["grid", "list"]} onChange={choose} />}
            {newButton}
          </>
        }
      />
      <PageBody>
        {!projects.length ? (
          <Card>
            <EmptyState icon={<Blocks />} title="No projects yet" description="Create a project to deploy your first app or database." action={newButton} />
          </Card>
        ) : view === "list" ? (
          <Card className="divide-y divide-line overflow-hidden">
            {projects.map((p) => (
              <ProjectRow key={p.id} project={p} />
            ))}
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {projects.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
        )}
      </PageBody>
    </>
  );
}
