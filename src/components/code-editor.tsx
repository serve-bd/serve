"use client";

import * as React from "react";
import CodeMirror, { type Extension } from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import { yaml } from "@codemirror/lang-yaml";
import { sql } from "@codemirror/lang-sql";
import { json } from "@codemirror/lang-json";
import { useTheme } from "@/hooks/use-client";
import { cn } from "@/lib/utils";

const LINE_HEIGHT = 20;

const languages: Record<string, () => Extension> = { yaml, sql: () => sql(), json };

/**
 * Code editor for config files (compose YAML) and queries (SQL, JSON): highlighting, line numbers,
 * bracket matching. Styled like the other inputs so it does not look bolted on.
 */
export function CodeEditor({
  value,
  onChange,
  onBlur,
  language = "yaml",
  placeholder,
  minRows = 12,
  maxHeight = "32rem",
  height,
  readOnly,
  className,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange?: (value: string) => void;
  onBlur?: () => void;
  language?: keyof typeof languages | "text";
  placeholder?: string;
  /** Rows shown before it scrolls. */
  minRows?: number;
  maxHeight?: string;
  /** A fixed height (the editor fills it and scrolls inside), instead of growing with the text. */
  height?: string;
  readOnly?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const { theme } = useTheme();

  // Built once per language: a new extension list recreates the editor and loses the cursor.
  const extensions = React.useMemo(
    () => [
      ...(language !== "text" ? [languages[language]()] : []),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of(ariaLabel ? { "aria-label": ariaLabel } : {}),
      EditorView.theme({
        "&": { fontSize: "12.5px", backgroundColor: "transparent !important" },
        "&.cm-focused": { outline: "none" },
        ".cm-content": {
          padding: "10px 0",
          fontFamily: "var(--font-code), ui-monospace, monospace",
          lineHeight: `${LINE_HEIGHT}px`,
          fontVariantLigatures: "none",
        },
        ".cm-line": { padding: "0 12px 0 8px" },
        ".cm-gutters": { backgroundColor: "transparent !important", border: "none", color: "var(--faint)", fontFamily: "var(--font-code), ui-monospace, monospace" },
        ".cm-lineNumbers .cm-gutterElement": { padding: "0 4px 0 12px", minWidth: "32px" },
        ".cm-scroller": { overflow: "auto", lineHeight: `${LINE_HEIGHT}px` },
        ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "var(--accent-soft) !important" },
        ".cm-cursor": { borderLeftColor: "var(--fg)" },
        ".cm-placeholder": { color: "var(--faint)" },
        ".cm-matchingBracket": { backgroundColor: "var(--accent-soft)", outline: "none" },
      }),
    ],
    [language, ariaLabel],
  );

  return (
    <div
      className={cn(
        "overflow-hidden rounded-[10px] border border-line-strong bg-surface shadow-sm transition-[border-color,box-shadow] focus-within:border-accent focus-within:ring-3 focus-within:ring-[var(--ring)]/40",
        readOnly && "bg-sunken",
        className,
      )}
      onBlur={onBlur}
    >
      <CodeMirror
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        readOnly={readOnly}
        theme={theme === "dark" ? "dark" : "light"}
        extensions={extensions}
        height={height}
        minHeight={height ? undefined : `${minRows * LINE_HEIGHT + 20}px`}
        maxHeight={height ? undefined : maxHeight}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          dropCursor: false,
          allowMultipleSelections: false,
          autocompletion: false,
          highlightSelectionMatches: false,
          searchKeymap: true,
          closeBrackets: true,
          bracketMatching: true,
          indentOnInput: true,
          tabSize: 2,
        }}
      />
    </div>
  );
}
