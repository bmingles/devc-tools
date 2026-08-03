// The wizard frame renderer: `WizardState` → exactly `size.rows` lines (plus SGR escapes
// when colour is on). Pure — it never touches the terminal; `term.ts` does the writing.
//
// Layout (design "Wizard layout"): a left **sidebar** listing steps (current highlighted),
// a **main** area with the current step's controls, and a **footer** of keybindings.
//
// Two invariants the tests pin down:
//   1. exactly `size.rows` lines, none wider than `size.columns` once ANSI is stripped;
//   2. with colour off there are no escape sequences at all, and the text equals the coloured
//      frame with ANSI stripped — so nothing is encoded in colour alone (the focused row keeps
//      a literal `>` gutter as well as reverse video).

import {
  skillsRows,
  sourceRows,
  type Step,
  type WizardState,
} from "./wizard_state.ts";
import { serializeMount } from "../mounts.ts";

export interface Size {
  columns: number;
  rows: number;
}

export const MIN_COLUMNS = 40;
export const MIN_ROWS = 8;
export const TOO_SMALL = `terminal too small (need ${MIN_COLUMNS}x${MIN_ROWS})`;

/** Width of the left sidebar, including its trailing separator column. */
const SIDEBAR_WIDTH = 18;

const SGR = {
  bold: "1",
  dim: "2",
};

/** True unless the user opted out with `--no-color` or `NO_COLOR`. */
export function colorEnabled(noColor = false): boolean {
  if (noColor) return false;
  const flag = Deno.env.get("NO_COLOR");
  return flag === undefined || flag === "";
}

/** Strip SGR sequences — used for width math and by the tests. */
export function stripAnsi(text: string): string {
  // deno-lint-ignore no-control-regex -- matching ESC is the entire point
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function sgr(text: string, style: string | undefined, color: boolean): string {
  if (!color || style === undefined || text === "") return text;
  return `\x1b[${style}m${text}\x1b[0m`;
}

function reverse(text: string, color: boolean): string {
  return color ? `\x1b[7m${text}\x1b[0m` : text;
}

/** Clip and pad `text` (measured with ANSI stripped) to exactly `width` columns. */
function fit(text: string, width: number): string {
  const plain = stripAnsi(text);
  if (plain.length > width) {
    // Coloured cells never exceed the sidebar/footer budget here, so a plain slice is safe.
    return plain.slice(0, width);
  }
  return text + " ".repeat(width - plain.length);
}

export function render(state: WizardState, size: Size): string[] {
  const height = Math.max(0, size.rows);
  if (size.columns < MIN_COLUMNS || size.rows < MIN_ROWS) {
    const lines = [TOO_SMALL.slice(0, Math.max(0, size.columns))];
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  const bodyHeight = height - 1; // last row is the footer
  const sidebar = sidebarLines(state, bodyHeight);
  const main = mainLines(state, size.columns - SIDEBAR_WIDTH - 1, bodyHeight);

  const lines: string[] = [];
  for (let i = 0; i < bodyHeight; i++) {
    const left = fit(sidebar[i] ?? "", SIDEBAR_WIDTH);
    const sep = sgr("|", SGR.dim, state.color);
    const right = fit(main[i] ?? "", size.columns - SIDEBAR_WIDTH - 1);
    lines.push(left + sep + right);
  }
  lines.push(fit(sgr(footerText(state), SGR.dim, state.color), size.columns));
  return lines.slice(0, height);
}

function sidebarLines(state: WizardState, height: number): string[] {
  const out: string[] = [sgr(" devc config", SGR.bold, state.color), ""];
  state.steps.forEach((step, i) => {
    const current = i === state.step;
    const label = ` ${current ? ">" : " "} ${step.title}`;
    out.push(current ? reverse(fit(label, SIDEBAR_WIDTH), state.color) : label);
  });
  while (out.length < height) out.push("");
  return out;
}

function mainLines(
  state: WizardState,
  width: number,
  height: number,
): string[] {
  const step = state.steps[state.step];
  const out: string[] = [sgr(` ${step.title}`, SGR.bold, state.color), ""];

  if (state.rootPicker !== null) {
    out.push(" Choose a root:");
    out.push("");
    state.rootPicker.roots.forEach((root, i) => {
      out.push(rowLine(state, `- ${root}`, i === state.rootPicker!.cursor, 1));
    });
  } else if (state.picker !== null) {
    const picker = state.picker;
    out.push(` ${picker.cwd}`);
    out.push("");
    out.push(
      rowLine(state, "[select this directory]", picker.cursor === -1, 1),
    );
    if (picker.entries.length === 0) {
      out.push("   " + sgr("(no subdirectories)", SGR.dim, state.color));
    }
    picker.entries.forEach((name, i) => {
      out.push(rowLine(state, `- ${name}/`, picker.cursor === i, 1));
    });
  } else if (step.kind === "global") {
    step.controls.forEach((control, c) => {
      out.push(rowLine(state, `[${control.label}]`, focused(state, c, -1), 1));
      if (control.items.length === 0) {
        out.push("     " + sgr("(none)", SGR.dim, state.color));
      }
      control.items.forEach((item, i) => {
        out.push(rowLine(state, `- ${item}`, focused(state, c, i), 3));
      });
      out.push("");
    });
  } else if (step.kind === "overview") {
    out.push(
      ` ${
        step.creating ? "Creating a new" : "Updating the existing"
      } devcontainer config:`,
    );
    out.push(`   ${step.basePath}`);
    out.push("");
    out.push(
      " The wizard manages only the devc:source and devc:skills mount blocks;",
    );
    out.push(" everything else is left untouched.");
    out.push("");
    out.push(" Press N (or Tab) to continue.");
  } else if (step.kind === "mounts") {
    out.push(rowLine(state, "[+ add folder]", focused(state, 0, -1), 1));
    if (step.rows.length === 0) {
      out.push("     " + sgr("(none)", SGR.dim, state.color));
    }
    step.rows.forEach((row, i) => {
      const ro = row.readonly ? " (ro)" : "";
      out.push(
        rowLine(
          state,
          `- ${row.source} -> ${row.target}${ro}`,
          focused(state, 0, i),
          3,
        ),
      );
    });
  } else if (step.kind === "review") {
    reviewLines(state).forEach((l) => out.push(l));
  }

  if (state.input !== null) {
    out.push("");
    const label = state.input.editRow !== undefined ? "target" : "add";
    out.push(
      ` ${label}: ${state.input.value}` + sgr("_", SGR.dim, state.color),
    );
  } else if (state.message !== "") {
    out.push("");
    out.push(` ${state.message}`);
  }

  void width;
  while (out.length < height) out.push("");
  return out;
}

function reviewLines(state: WizardState): string[] {
  const out: string[] = [];
  const overview = state.steps.find((
    s,
  ): s is Extract<Step, { kind: "overview" }> => s.kind === "overview");
  const status = overview?.creating ? "new" : "update";
  out.push(` Ready to apply (${status}).`);
  out.push("");
  out.push(" // devc:source");
  const src = sourceRows(state);
  if (src.length === 0) out.push("   " + sgr("(empty)", SGR.dim, state.color));
  for (const r of src) out.push(`   "${serializeMount(r)}"`);
  out.push("");
  out.push(" // devc:skills");
  const sk = skillsRows(state);
  if (sk.length === 0) out.push("   " + sgr("(empty)", SGR.dim, state.color));
  for (const r of sk) out.push(`   "${serializeMount(r)}"`);
  out.push("");
  out.push(" Press A to apply.");
  return out;
}

function focused(state: WizardState, control: number, item: number): boolean {
  return state.input === null &&
    state.focus.control === control && state.focus.item === item;
}

function rowLine(
  state: WizardState,
  text: string,
  isFocused: boolean,
  indent: number,
): string {
  const gutter = isFocused ? ">" : " ";
  const body = `${gutter}${" ".repeat(indent)}${text}`;
  return isFocused ? reverse(body, state.color) : body;
}

function footerText(state: WizardState): string {
  if (state.input !== null) return " type a value  Enter accept  Esc cancel";
  if (state.rootPicker !== null) {
    return " up/down choose  Enter open  Q/Esc cancel";
  }
  if (state.picker !== null) {
    return " up/down move  Enter open/select  S select dir  Q/Esc cancel";
  }
  const step = state.steps[state.step];
  if (step.kind === "global") {
    return " up/down focus  Enter add  Backspace/D remove  A next  Q quit";
  }
  if (step.kind === "mounts") {
    return " up/down  A add  E target  O readonly  D remove  N next  B back  Q quit";
  }
  if (step.kind === "review") return " A apply  B back  Q quit";
  return " N next  B back  Q quit";
}
