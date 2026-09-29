/** Posts a GitHub App manifest (GitHub requires a top-level form POST). */
export function postManifest(action: string, manifest: string) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = action;
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "manifest";
  input.value = manifest;
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
}
