import * as React from "react";

let next = 0;

/**
 * Base UI checkboxes and switches are a <span role>: a wrapping <label> does not name them, and in a
 * Field they get the field's label, the same for every option. Names the control after its own
 * <label> instead, so screen readers announce the text next to it.
 */
export function useNameFromLabel<T extends HTMLElement>(ref: React.Ref<T> | undefined, props: { "aria-label"?: string; "aria-labelledby"?: string }) {
  const [labelId, setLabelId] = React.useState<string>();
  const explicit = !!props["aria-label"] || !!props["aria-labelledby"];
  const setRef = React.useCallback(
    (el: T | null) => {
      const label = el && !explicit ? el.closest("label") : null;
      if (label) {
        label.id ||= `label-${++next}`;
        setLabelId(label.id);
      }
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [ref, explicit],
  );
  return { ref: setRef, "aria-labelledby": props["aria-labelledby"] ?? (explicit ? undefined : labelId) };
}
