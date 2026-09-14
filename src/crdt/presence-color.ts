/**
 * Presence palette for human devices (the agent keeps its brand amber). A stable per-identity colour so
 * concurrent devices are distinguishable in the editor. Amber is deliberately excluded (agent-only).
 */
const PRESENCE_COLORS = ["#5B8DEF", "#2FB67C", "#A66BEF", "#E85D9E", "#22A7C7", "#E0603A"];

/** A stable colour for any identity string or client id. Ours to choose — never a peer's to send. */
export function colorFromId(id: string | number): string {
	const s = String(id);
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
	return PRESENCE_COLORS[h % PRESENCE_COLORS.length] as string;
}

/** The translucent companion shade yCollab paints selections with. */
export function colorLightFromId(id: string | number): string {
	return `${colorFromId(id)}33`;
}
