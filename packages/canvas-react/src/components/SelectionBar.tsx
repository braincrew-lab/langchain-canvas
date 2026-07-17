/**
 * The quick-edit bar shown when the user has selected an element inside an
 * `html` artifact. It displays what's selected and takes a natural-language
 * instruction; submitting sends a targeted edit (the selection rides along as
 * context so the agent changes only that element).
 */

import { useState } from "react";

import type { ElementSelection } from "../protocol/selection";

interface SelectionBarProps {
  selections: ElementSelection[];
  onEdit: (instruction: string) => void;
  onClear: () => void;
}

export function SelectionBar({ selections, onEdit, onClear }: SelectionBarProps) {
  const [instruction, setInstruction] = useState("");
  const primary = selections[0];
  const label = selections.length === 1 ? primary.selector : `${selections.length} elements`;

  const submit = () => {
    const text = instruction.trim();
    if (!text) return;
    onEdit(text);
    setInstruction("");
  };

  return (
    <div className="cv-selection">
      <span className="cv-selection__chip" title={primary?.text}>
        {label}
      </span>
      <input
        className="cv-selection__input"
        value={instruction}
        placeholder={selections.length === 1 ? `Edit this ${primary.tag}…` : `Edit ${selections.length} elements…`}
        autoFocus
        onChange={(e) => setInstruction(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onClear();
        }}
      />
      <button className="cv-selection__apply" onClick={submit} disabled={!instruction.trim()}>
        Apply
      </button>
      <button className="cv-selection__clear" onClick={onClear} aria-label="Clear selection">
        ✕
      </button>
    </div>
  );
}
