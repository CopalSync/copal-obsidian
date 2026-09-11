import { Compartment, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { yCollab } from "y-codemirror.next";
import type { Awareness } from "y-protocols/awareness";
import type { Text as YText, UndoManager } from "yjs";

/**
 * Binds a note's `Y.Text` directly to Obsidian's CodeMirror 6 editor via y-codemirror.next — so human and
 * agent edits are live and character-level, with **no `.md` file buffer in the loop** (the P2 divergence
 * came from the file-bridge racing Obsidian's buffer saves). A single CM6 `Compartment` (registered once
 * via `registerEditorExtension`) is reconfigured per note as the user switches — Obsidian reuses editor
 * instances, so the binding must be swappable, not baked into the initial state.
 */
export class EditorBinding {
	private readonly compartment = new Compartment();

	/** Register once: `this.registerEditorExtension([binding.extension()])`. Empty until a note is bound. */
	extension(): Extension {
		return this.compartment.of([]);
	}

	/** Bind `ytext` to `view` — edits now flow both ways live; remote (agent) edits appear as you type. */
	attach(view: EditorView, ytext: YText, awareness: Awareness, undoManager?: UndoManager): void {
		const collab = yCollab(ytext, awareness, undoManager ? { undoManager } : undefined);
		view.dispatch({ effects: this.compartment.reconfigure(collab) });
	}

	/** Unbind — leave the editor as a plain Obsidian editor (on note switch / disconnect). */
	detach(view: EditorView): void {
		view.dispatch({ effects: this.compartment.reconfigure([]) });
	}
}
