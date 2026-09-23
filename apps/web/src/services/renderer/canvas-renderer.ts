import type { FrameRate } from "opencut-wasm";
import type { AnyBaseNode } from "./nodes/base-node";
import { buildFrameDescriptor } from "./compositor/frame-descriptor";
import { wasmCompositor } from "./compositor/wasm-compositor";
import { resolveRenderTree } from "./resolve";
import {
	measureSpanAsync,
	measureSpanSync,
	onRenderPerfFrameComplete,
} from "@/diagnostics/render-perf";

export type CanvasRendererParams = {
	width: number;
	height: number;
	fps: FrameRate;
};

export class CanvasRenderer {
	width: number;
	height: number;
	fps: FrameRate;

	constructor({ width, height, fps }: CanvasRendererParams) {
		this.width = width;
		this.height = height;
		this.fps = fps;
	}

	/**
	 * The compositor's output canvas, or null when the GPU is unavailable.
	 *
	 * Callers must handle null: there is no CPU rendering path any more, so a
	 * machine without a usable GPU can preview nothing. The alternative — the
	 * old `throw new Error("Compositor is not initialized")` — surfaced as an
	 * uncaught error in a React effect rather than as a plain "preview
	 * unavailable", which is what the user actually needs to be told.
	 */
	getOutputCanvas(): HTMLCanvasElement | null {
		return wasmCompositor.ensureInitialized({
			width: this.width,
			height: this.height,
		});
	}

	setSize({ width, height }: { width: number; height: number }) {
		this.width = width;
		this.height = height;
	}

	async render({ node, time }: { node: AnyBaseNode; time: number }) {
		// Checked before the tree walk rather than after it: without a
		// compositor canvas there is nothing to draw into, and resolving the
		// tree would be work discarded on every frame of playback.
		const outputCanvas = wasmCompositor.ensureInitialized({
			width: this.width,
			height: this.height,
		});
		if (!outputCanvas) return;

		await measureSpanAsync({
			name: "resolve",
			fn: () => resolveRenderTree({ node, renderer: this, time }),
		});
		const { frame, textures } = await measureSpanAsync({
			name: "buildFrame",
			fn: () => buildFrameDescriptor({ node, renderer: this }),
		});

		measureSpanSync({
			name: "syncTextures",
			fn: () => wasmCompositor.syncTextures(textures),
		});
		measureSpanSync({
			name: "renderFrame",
			fn: () => wasmCompositor.render(frame),
		});
	}

	async renderToCanvas({
		node,
		time,
		targetCanvas,
	}: {
		node: AnyBaseNode;
		time: number;
		targetCanvas: HTMLCanvasElement;
	}): Promise<boolean> {
		await this.render({ node, time });

		const outputCanvas = wasmCompositor.ensureInitialized({
			width: this.width,
			height: this.height,
		});
		if (!outputCanvas) return false;

		const ctx = targetCanvas.getContext("2d");
		if (!ctx) {
			throw new Error("Failed to get target canvas context");
		}

		measureSpanSync({
			name: "drawImage",
			fn: () =>
				ctx.drawImage(
					outputCanvas,
					0,
					0,
					targetCanvas.width,
					targetCanvas.height,
				),
		});
		onRenderPerfFrameComplete();
		return true;
	}
}
