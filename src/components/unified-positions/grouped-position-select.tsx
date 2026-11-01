"use client";

import type { PositionGroup } from "@/lib/unified-positions/rows";
import type { UnifiedPosition } from "@/lib/unified-positions/model";
import { SELECT_CHEVRON_STYLE } from "../position-select";

/** My positions: one native `<select>`, one `<optgroup>` per chain (Solana, Robinhood Chain); option values are position keys. */
export function GroupedPositionSelect({ id, label, value, onChange, disabled, groups, optionLabel, emptyOption, placeholder, className }: {
  id: string; label: string; value: string; onChange: (key: string) => void; disabled?: boolean;
  groups: PositionGroup[]; optionLabel: (position: UnifiedPosition, group: PositionGroup) => string;
  emptyOption: (group: PositionGroup) => string; placeholder?: string; className: string;
}) {
  return <div>
    <label htmlFor={id} className="sr-only">{label}</label>
    <select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}
      className={`${className} min-w-0 max-w-full truncate`} style={SELECT_CHEVRON_STYLE}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {groups.map((group) => <optgroup key={group.chain} label={group.label}>
        {group.positions.length
          ? group.positions.map((position) => <option key={position.key} value={position.key}>{optionLabel(position, group)}</option>)
          : <option value={`empty:${group.chain}`} disabled>{emptyOption(group)}</option>}
      </optgroup>)}
    </select>
  </div>;
}
