"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { Combobox } from "@/components/ui/combobox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useDebounced, useLatest } from "@/hooks/use-client";
import { timeAgo } from "@/lib/utils";
import { browseImageTags, browseRegistryImages } from "@/server/actions/registries";

export type PickerRegistry = { id: string; name: string; host: string };

/** "" = a public image, "manual" = a private one with a typed login, else a saved registry's id. */
export type RegistryChoice = string;

type Images = { list: { name: string; ref: string; updatedAt: string | null; private: boolean | null }[]; listable: boolean; note: string | null };
type Tags = { name: string; updatedAt: string | null }[];

/** Repository and tag of a reference: "ghcr.io/a/b:1" → ["ghcr.io/a/b", "1"]. */
function splitTag(ref: string): [string, string | null] {
  const at = ref.lastIndexOf(":");
  return at > ref.lastIndexOf("/") ? [ref.slice(0, at), ref.slice(at + 1)] : [ref, null];
}

/**
 * Registry, image and tag for a Docker image service. A saved registry lists its images and pulls
 * with its login; tags are listed for any image, newest first. Typing a full reference always works.
 */
export function ImagePicker({
  registries,
  registry,
  image,
  onChange,
  autoFocus,
}: {
  registries: PickerRegistry[];
  registry: RegistryChoice;
  image: string;
  onChange: (registry: RegistryChoice, image: string) => void;
  autoFocus?: boolean;
}) {
  const saved = registries.find((r) => r.id === registry) ?? null;
  const [repo, tag] = splitTag(image.trim());
  const [images, setImages] = React.useState<Images | null>(null);
  const [imagesError, setImagesError] = React.useState<string | null>(null);
  const [loadingImages, setLoadingImages] = React.useState(false);
  const [tags, setTags] = React.useState<Tags | null>(null);
  const [tagsError, setTagsError] = React.useState<string | null>(null);
  const [loadingTags, setLoadingTags] = React.useState(false);
  const [typeName, setTypeName] = React.useState(false);

  // The images of the chosen registry.
  const savedId = saved?.id ?? null;
  React.useEffect(() => {
    setImages(null);
    setImagesError(null);
    setTypeName(false);
    if (!savedId) return;
    let live = true;
    setLoadingImages(true);
    browseRegistryImages(savedId)
      .then((res) => {
        if (!live) return;
        if (res.ok) setImages({ list: res.data.images, listable: res.data.listable, note: res.data.note });
        else setImagesError(res.error);
      })
      .catch(() => live && setImagesError("Could not list the images."))
      .finally(() => live && setLoadingImages(false));
    return () => {
      live = false;
    };
  }, [savedId]);

  const latest = useLatest({ onChange, registry, repo, tag });

  // Tags of the image, once its name stops changing. A login typed by hand is not sent anywhere.
  const tagRepo = useDebounced(registry === "manual" ? "" : repo, 500);
  // biome-ignore lint/correctness/useExhaustiveDependencies: latest is a ref read when the answer arrives
  React.useEffect(() => {
    setTags(null);
    setTagsError(null);
    if (tagRepo.length < 2) return;
    let live = true;
    setLoadingTags(true);
    browseImageTags({ registryId: savedId, image: tagRepo })
      .then((res) => {
        if (!live) return;
        if (!res.ok) return setTagsError(res.error);
        setTags(res.data.tags);
        // A freshly picked image gets its newest tag ("latest" when dates are unknown).
        const now = latest.current;
        if (res.data.tags.length && !now.tag && now.repo === tagRepo) now.onChange(now.registry, `${tagRepo}:${res.data.tags[0].name}`);
      })
      .catch(() => live && setTagsError("Could not list the tags."))
      .finally(() => live && setLoadingTags(false));
    return () => {
      live = false;
    };
  }, [tagRepo, savedId]);

  const registryOptions = [
    { value: "", label: "Public image", description: "Docker Hub or any public registry" },
    ...registries.map((r) => ({ value: r.id, label: r.name, description: r.host })),
    { value: "manual", label: "Other private registry", description: "Enter a username and token" },
  ];
  const listed = !!saved && !!images?.listable && !typeName && !imagesError;

  return (
    <div className="flex flex-col gap-4">
      <Field label="Registry" description={saved ? `Pulls with the login saved for ${saved.name}.` : undefined}>
        <Select
          value={registry}
          // An image belongs to its registry: a typed public name is kept only between the two kinds without a list.
          onValueChange={(v) => onChange(v, v === registry || ((v === "" || v === "manual") && !saved) ? image : "")}
          options={registryOptions}
          aria-label="Registry"
        />
      </Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_14rem]">
        <Field
          label="Image"
          description={
            listed ? (
              <button type="button" className="text-accent" onClick={() => setTypeName(true)}>
                Type a name instead
              </button>
            ) : saved ? (
              (images?.note ?? imagesError ?? `For example ${saved.host}/team/app`)
            ) : (
              "For example nginx:alpine, ghcr.io/owner/app:latest"
            )
          }
        >
          {loadingImages ? (
            <div className="flex h-9 items-center gap-2 text-[13px] text-muted">
              <Loader2 className="size-3.5 animate-spin" /> Loading images…
            </div>
          ) : listed ? (
            <Combobox
              value={repo || null}
              onValueChange={(v) => onChange(registry, v)}
              options={(images?.list ?? []).map((i) => ({
                value: i.ref,
                label: i.name,
                description: [i.private ? "private" : null, i.updatedAt ? `updated ${timeAgo(i.updatedAt)}` : null].filter(Boolean).join(" · ") || undefined,
              }))}
              placeholder={images?.list.length ? `Search ${images.list.length} images` : "No images in this registry"}
              emptyText="No image with that name"
            />
          ) : (
            <Input
              value={image}
              onChange={(e) => onChange(registry, e.target.value)}
              placeholder={saved ? `${saved.host}/team/app:latest` : "traefik/whoami:latest"}
              required
              autoFocus={autoFocus}
              className="font-mono text-[13px]"
              aria-label="Image"
            />
          )}
        </Field>
        <Field label="Tag" description={tagsError ? "Could not list the tags." : tags && !tags.length ? "No tags found." : undefined}>
          {loadingTags ? (
            <div className="flex h-9 items-center gap-2 text-[13px] text-muted">
              <Loader2 className="size-3.5 animate-spin" /> Loading tags…
            </div>
          ) : tags?.length ? (
            <Combobox
              value={tag}
              onValueChange={(v) => onChange(registry, `${repo}:${v}`)}
              options={tags.map((t) => ({ value: t.name, label: t.name, description: t.updatedAt ? timeAgo(t.updatedAt) : undefined }))}
              placeholder={`Search ${tags.length} tags`}
              emptyText="No tag with that name"
            />
          ) : (
            <Input
              value={tag ?? ""}
              onChange={(e) => onChange(registry, e.target.value.trim() ? `${repo}:${e.target.value.trim()}` : repo)}
              placeholder="latest"
              disabled={!repo}
              className="font-mono text-[13px]"
              aria-label="Tag"
            />
          )}
        </Field>
      </div>
    </div>
  );
}
